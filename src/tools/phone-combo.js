// 묶음 도구 (2026-10-30): 자주 하는 폰 작업을 호출 한 번으로 처리해 Claude 쪽 왕복 횟수를 줄인다.
// 써니 폰 컨트롤 앱 도구(callPhoneTool)를 폰 안에서 이어 부른다. 앱 재빌드 없이 여기서 고친다.
import * as z from 'zod/v4';
import { callPhoneTool } from './phone.js';
import { errorResult, json, text } from '../result.js';

const SKIP_PKGS = new Set(['com.android.systemui']);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function resultText(res) {
  return (res?.content ?? []).map((b) => b.text ?? '').join('\n');
}

// get_screen_state 출력 → { windows: [{pkg, title, type, focused, nodes:[{id,cls,text,desc,res,bounds,flags}]}] }
function parseScreen(raw) {
  const windows = [];
  let cur = null;
  for (const line of raw.split('\n')) {
    if (line.startsWith('--- window:')) {
      const m = (k) => (line.match(new RegExp(`${k}:(\\S+)`)) ?? [])[1];
      cur = {
        pkg: m('pkg'),
        type: m('type'),
        title: (line.match(/title:(.*?) (activity|layer):/) ?? [])[1],
        focused: m('focused') === 'true',
        nodes: [],
      };
      windows.push(cur);
      continue;
    }
    if (!cur || !line.startsWith('node_') || line.startsWith('node_id\t')) continue;
    const [id, cls, t, desc, res, bounds, flags] = line.split('\t');
    cur.nodes.push({
      id, cls,
      text: t === '-' ? '' : t,
      desc: desc === '-' ? '' : desc,
      res: res === '-' ? '' : res,
      bounds,
      flags: (flags ?? '').split(','),
    });
  }
  return windows;
}

async function screen() {
  const res = await callPhoneTool('get_screen_state', { include_hierarchy: false, include_offscreen: false });
  if (res.isError) throw new Error(resultText(res));
  return parseScreen(resultText(res));
}

function appWindows(windows) {
  return windows.filter((w) => !SKIP_PKGS.has(w.pkg) && w.type !== 'INPUT_METHOD');
}

function summarize(windows, { max = 80 } = {}) {
  const out = [];
  for (const w of appWindows(windows)) {
    const lines = [];
    const seen = new Set();
    for (const n of w.nodes) {
      const label = n.text || n.desc;
      if (!label || seen.has(label)) continue;
      seen.add(label);
      const tags = [n.flags.includes('edt') ? '입력칸' : null, n.flags.includes('clk') ? '탭' : null].filter(Boolean);
      lines.push(`${label}${tags.length ? ` [${tags.join(',')}]` : ''}`);
      if (lines.length >= max) break;
    }
    out.push(`# ${w.pkg}${w.title && w.title !== 'unknown' ? ` (${w.title})` : ''}${w.focused ? ' *포커스' : ''}`);
    out.push(...(lines.length ? lines : ['(글자 요소 없음 — 필요하면 phone_get_screen_state include_screenshot=true)']));
  }
  return out.join('\n');
}

function findEditable(windows, target) {
  const nodes = appWindows(windows).flatMap((w) => w.nodes).filter((n) => n.flags.includes('edt'));
  if (!target) return nodes[0];
  const q = target.toLowerCase();
  return nodes.find((n) => [n.text, n.desc, n.res].some((v) => v.toLowerCase().includes(q))) ?? null;
}

export function registerPhoneComboTools(register) {
  register(
    'phone_screen_text',
    {
      title: 'Phone: screen text (light)',
      description:
        '가벼운 화면 보기: 지금 화면의 앱 이름과 보이는 글자만 짧게 돌려준다(상태바·키보드 제외, 입력칸/탭 가능 표시). ' +
        '노드 ID·좌표가 필요 없을 때 phone_get_screen_state 대신 쓴다. 조작하려면 phone_get_screen_state.',
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: z.object({ max_lines: z.number().int().min(5).max(300).optional() }),
    },
    async (args) => {
      try {
        return text(summarize(await screen(), { max: args.max_lines ?? 80 }));
      } catch (error) {
        return errorResult(error.message);
      }
    },
  );

  register(
    'phone_fill_text',
    {
      title: 'Phone: type into a field (one call)',
      description:
        '화면에서 입력칸을 찾아(target: 칸의 글자/힌트/리소스ID 일부, 생략하면 첫 입력칸) 글자를 넣고, enter=true면 엔터까지 누른 뒤 ' +
        '바뀐 화면 글자를 돌려준다. 검색창 입력·메시지 입력에 쓴다. 터먹스 터미널 화면은 입력칸이 아니라서 안 된다(명령은 shell 도구).',
      annotations: { readOnlyHint: false, openWorldHint: false },
      inputSchema: z.object({
        text: z.string().min(1).max(2000),
        target: z.string().optional(),
        enter: z.boolean().optional(),
      }),
    },
    async (args) => {
      try {
        let node = findEditable(await screen(), args.target);
        if (!node) return errorResult(`입력칸을 못 찾음${args.target ? ` (target=${args.target})` : ''}`);
        const type = (n) => callPhoneTool('type_append_text', {
          node_id: n.id, text: args.text, typing_speed: 10, typing_speed_variance: 0,
        });
        let typed = await type(node);
        // 첫 입력 때 칸에 포커스가 가면서 화면이 바뀌면(예: 크롬 주소창) 입력 연결이 끊긴다 → 칸을 다시 찾아 한 번 더.
        if (typed.isError && /connection lost|not found|stale/i.test(resultText(typed))) {
          await sleep(400);
          node = findEditable(await screen(), args.target);
          if (!node) return errorResult('입력칸이 사라짐(재시도 실패)');
          typed = await type(node);
        }
        if (typed.isError) return typed;
        if (args.enter) {
          await callPhoneTool('press_key', { key: 'ENTER' });
          await sleep(700);
        }
        return text(`입력함 → ${node.text || node.desc || node.res || node.id}${args.enter ? ' + 엔터' : ''}\n\n${summarize(await screen(), { max: 40 })}`);
      } catch (error) {
        return errorResult(error.message);
      }
    },
  );

  register(
    'phone_copy_text',
    {
      title: 'Phone: copy on-screen text to clipboard',
      description:
        '화면에 보이는 글자 중 match를 포함한 요소의 글자 전체를 클립보드에 복사한다(match 생략 시 text를 그대로 복사). ' +
        '붙여넣기는 phone_fill_text로 같은 글자를 입력하거나, 사용자가 길게 눌러 붙여넣는다.',
      annotations: { readOnlyHint: false, openWorldHint: false },
      inputSchema: z.object({ match: z.string().optional(), text: z.string().optional() }),
    },
    async (args) => {
      try {
        let value = args.text;
        if (!value) {
          if (!args.match) return errorResult("'match' 또는 'text'가 필요함");
          const q = args.match.toLowerCase();
          const node = appWindows(await screen()).flatMap((w) => w.nodes)
            .find((n) => (n.text || n.desc).toLowerCase().includes(q));
          if (!node) return errorResult(`화면에서 '${args.match}'를 못 찾음`);
          value = node.text || node.desc;
          const full = await callPhoneTool('get_node_details', { node_ids: [node.id] }).catch(() => null);
          const m = full && resultText(full).match(/"text"\s*:\s*"((?:[^"\\]|\\.)*)"/);
          if (m) value = JSON.parse(`"${m[1]}"`);
        }
        const res = await callPhoneTool('set_clipboard', { text: value });
        if (res.isError) return res;
        return json({ copied: value.length > 200 ? `${value.slice(0, 200)}…` : value, chars: value.length });
      } catch (error) {
        return errorResult(error.message);
      }
    },
  );
}
