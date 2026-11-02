// 재부팅 묶음 도구 (2026-11-03): 루팅 없이 화면 조작으로 폰을 다시 시작한다.
// 순서(샤인이 알려준 방법): 빠른 설정 열기 → 전원 아이콘 → "다시 시작" → 확인 화면의 "다시 시작"
// 단계마다 화면을 확인하고, 성공/실패와 사유를 ~/.termux-mcp/reboot.log 에 남긴다.
import fs from 'node:fs';
import path from 'node:path';
import * as z from 'zod/v4';
import { callPhoneTool } from './phone.js';
import { stateDir } from '../paths.js';
import { errorResult, json } from '../result.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LOG = path.join(stateDir, 'reboot.log');

function kst() {
  return new Date(Date.now() + 9 * 3600e3).toISOString().replace('T', ' ').slice(0, 23);
}
function log(msg) {
  try {
    fs.appendFileSync(LOG, `${kst()} [phone_reboot] ${msg}\n`);
  } catch (e) {
    console.error(`[phone_reboot] log write failed: ${e.message}`);
  }
}
function resText(res) {
  return (res?.content ?? []).map((b) => b.text ?? '').join('\n');
}

async function nodes() {
  const res = await callPhoneTool('get_screen_state', { include_hierarchy: false, include_offscreen: false });
  if (res.isError) throw new Error(`화면 읽기 실패: ${resText(res)}`);
  const out = [];
  for (const line of resText(res).split('\n')) {
    if (!line.startsWith('node_') || line.startsWith('node_id\t')) continue;
    const [id, cls, text, desc, rid, bounds, flags] = line.split('\t');
    out.push({ id, cls, text: text === '-' ? '' : text, desc: desc === '-' ? '' : desc, rid: rid === '-' ? '' : rid, bounds, flags: flags ?? '' });
  }
  return out;
}

async function waitFor(pred, { tries = 8, gap = 500 } = {}) {
  for (let i = 1; i <= tries; i++) {
    const found = (await nodes()).filter(pred);
    if (found.length) return { node: found[0], all: found, tries: i };
    await sleep(gap);
  }
  return null;
}

async function press(node, label) {
  const c = await callPhoneTool('click_node', { node_id: node.id });
  if (!c.isError) { log(`${label} click_node 성공`); return 'click'; }
  log(`${label} click_node 실패(${resText(c).replace(/\s+/g, ' ').slice(0, 120)}) → tap_node 시도`);
  const t = await callPhoneTool('tap_node', { node_id: node.id });
  if (t.isError) throw new Error(`${label} 누르기 실패: ${resText(t)}`);
  log(`${label} tap_node 성공`);
  return 'tap';
}

const isRestart = (n) => /^다시 시작|^재시작|^Restart/i.test(n.desc || n.text);

export function registerPhoneRebootTools(register) {
  register(
    'phone_reboot',
    {
      title: 'Reboot the phone (screen automation)',
      description:
        '루팅 없이 화면 조작으로 폰을 다시 시작한다: 빠른 설정 → 전원 아이콘 → "다시 시작" → 확인 "다시 시작". ' +
        'confirm:true 필수. dry_run:true면 마지막 확인 버튼 직전까지만 가고 메뉴를 닫는다. ' +
        '재부팅되면 이 MCP 연결과 음성 통화가 끊긴다. 기록: ~/.termux-mcp/reboot.log',
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      inputSchema: z.object({
        confirm: z.boolean().describe('Must be true.'),
        dry_run: z.boolean().optional(),
      }),
    },
    async (args) => {
      if (args.confirm !== true) return errorResult('refused: 재부팅은 confirm: true 가 필요합니다.');
      const steps = [];
      try {
        log(`=== 시작 (dry_run=${!!args.dry_run}) ===`);
        // 1) 빠른 설정 열기 → 전원 아이콘 찾기 (안 보이면 한 번 더 열기)
        let power = null;
        for (let attempt = 1; attempt <= 2 && !power; attempt++) {
          const r = await callPhoneTool('open_quick_settings', {});
          if (r.isError) throw new Error(`빠른 설정 열기 실패: ${resText(r)}`);
          await sleep(1200);
          power = await waitFor((n) => /power_button$/.test(n.rid) || /^전원 끄기$/.test(n.desc), { tries: 4 });
          log(power ? `1 빠른 설정 열기 성공, 전원 아이콘 찾음 (시도 ${attempt})` : `1 전원 아이콘 못 찾음 (시도 ${attempt})`);
        }
        if (!power) throw new Error('1단계 실패: 빠른 설정에서 전원 아이콘을 찾지 못함');
        steps.push('빠른 설정 열기 + 전원 아이콘 찾음');

        // 2) 전원 아이콘 누르기 → 전원 메뉴의 "다시 시작"
        await press(power.node, '2 전원 아이콘');
        const r1 = await waitFor((n) => isRestart(n) && /global_actions/.test(n.rid), { tries: 8 });
        if (!r1) throw new Error('2단계 실패: 전원 메뉴에서 "다시 시작"이 나타나지 않음');
        log('2 전원 메뉴 열림, "다시 시작" 찾음');
        steps.push('전원 메뉴 열림');

        // 3) "다시 시작" 누르기 → 확인 화면의 "다시 시작"
        await press(r1.node, '3 다시 시작(1차)');
        await sleep(800);
        const r2 = await waitFor((n) => isRestart(n), { tries: 8 });
        if (!r2) throw new Error('3단계 실패: 확인 화면의 "다시 시작"이 나타나지 않음');
        log(`3 확인 화면 "다시 시작" 찾음 (${r2.node.id} ${r2.node.rid || r2.node.cls})`);
        steps.push('확인 화면 열림');

        if (args.dry_run) {
          await callPhoneTool('press_back', {});
          await sleep(400);
          await callPhoneTool('press_back', {});
          log('dry_run: 최종 확인 직전에서 멈추고 메뉴 닫음 — 성공');
          return json({ ok: true, dry_run: true, steps, final_button: r2.node });
        }

        // 4) 최종 확인 — 응답을 먼저 돌려준 뒤 2초 후 누른다 (누르면 서버가 꺼지므로)
        const final = r2.node;
        setTimeout(async () => {
          try {
            await press(final, '4 다시 시작(최종)');
            log('4 최종 확인 누름 — 재부팅 진행');
          } catch (e) {
            log(`4 최종 확인 실패: ${e.message}`);
          }
        }, 2000);
        steps.push('2초 뒤 최종 "다시 시작" 누름 예약');
        return json({ ok: true, rebooting: true, steps, note: '곧 재부팅됩니다. 켜지면 화면 잠금을 풀어 주세요.' });
      } catch (e) {
        log(`실패: ${e.message}`);
        try { await callPhoneTool('press_back', {}); } catch {}
        return errorResult(`${e.message}\n완료된 단계: ${steps.join(' → ') || '없음'}\n기록: ${LOG}`);
      }
    },
  );
}
