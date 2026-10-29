import { McpServer } from '@modelcontextprotocol/server';
import { audit } from './audit.js';
import { describeError, errorResult } from './result.js';
import { registerApiTools } from './tools/api.js';
import { registerFsTools } from './tools/fs.js';
import { registerPhoneTools } from './tools/phone.js';
import { registerShellTools } from './tools/shell.js';
import { registerSystemTools } from './tools/system.js';

export const SERVER_NAME = 'termux-mcp';

const INSTRUCTIONS = `Control the Android device this Termux install is running on.

Grouping:
- shell, shell_bg, shell_jobs, shell_logs, shell_kill run commands in the Termux shell.
- fs_* read and write files, but only inside the configured allowed roots.
- battery_status, clipboard_*, location, screenshot, camera_photo, mic_record, notification, dialog,
  share, sms_*, tts_speak, wifi_* and api_run drive the Android APIs through termux-api.
- system_info, proc_*, pkg_*, storage_info, network_info, audit_tail report device state.
- phone_* drive the screen through the Sunny Phone Control app (accessibility): phone_get_screen_state
  reads any app's UI, phone_tap/phone_click_node/phone_type_* act on it, phone_notification_* handle
  notifications, phone_open_app/phone_send_intent launch apps. phone_status checks the app.


실전 규칙 (휴대폰 조작 요청, 2026-10-30 추가 — 도구별 세부 규칙은 각 phone_* 설명문 끝 [실전 규칙]):
- 결과를 말할 때 '명령 전달 성공'과 '화면에서 확인한 결과'를 구분한다. 화면 확인은 phone_get_screen_state.
- 곡·영상 재생 요청: phone_youtube_play. 같은 곡도 영상이 여러 개이므로 특정 영상을 원하거나 정확도가 중요하면
  웹 검색으로 정확한 영상 주소를 찾아 video_id(watch?v= 뒤 11자)로 넘긴다. 재생까지 확인한 뒤 '재생 중'이라고 말한다.
- 앱 열기: phone_open_app(package_id). 패키지 이름을 모르면 phone_list_apps(name_query)로 찾는다.
- 화면 조작 순서: phone_get_screen_state로 요소 확인 → phone_click_node → 안 되면 phone_tap_node → 마지막에 좌표 phone_tap
  → 다시 phone_get_screen_state로 확인.
- 글자 입력: phone_type_append_text(칸 지정) → 검색은 phone_press_key(ENTER).
- 설정 화면 등은 shell의 am start보다 phone_send_intent가 확실하다(Termux는 백그라운드에서 화면을 못 띄울 때가 있다).
- 잠금 화면이면 조작하지 말고 사용자에게 잠금 해제를 부탁한다. Termux·Sunny Phone Control 알림은 지우지 않는다.
- 같은 도구를 불필요하게 반복 호출하지 않는다.

Safety rules that apply to you:
- Commands and tools marked destructive refuse to run unless you pass confirm: true. Only add
  confirm: true when the user has actually asked for that exact action.
- fs_delete, pkg_upgrade, proc_kill, sms_send, tmux_kill and tar extraction also need confirm: true.
- fs_* tools are jailed to the allowed roots. If a path is refused, say so instead of trying to
  work around it with shell.
- Prefer one specific tool over api_run, and read a file before overwriting it.`;

function summarise(args) {
  const text = JSON.stringify(args ?? {}, (key, value) =>
    typeof value === 'string' && value.length > 300 ? `${value.slice(0, 300)}…` : value,
  );
  return text.length > 1200 ? `${text.slice(0, 1200)}…` : text;
}

export function createServer(ctx) {
  const { config, authInfo = null, mode = 'stdio' } = ctx;
  const server = new McpServer(
    { name: SERVER_NAME, version: ctx.version ?? '0.1.0' },
    { instructions: INSTRUCTIONS },
  );

  const register = (name, definition, handler) => {
    const readOnly = definition.annotations?.readOnlyHint === true;
    const requiredScope = readOnly ? 'read' : 'full';

    server.registerTool(name, definition, async (args, requestContext) => {
      const caller = requestContext?.http?.authInfo ?? authInfo;
      const callerScopes = new Set(caller?.scopes ?? ['full']);
      const callerName = caller?.clientId ?? (mode === 'stdio' ? 'stdio' : 'anonymous');
      const startedAt = Date.now();

      if (!callerScopes.has('full') && !callerScopes.has(requiredScope)) {
        audit({ action: 'tool_denied', tool: name, caller: callerName, scopes: [...callerScopes] });
        return errorResult(
          `refused: ${name} needs the "full" scope and this token only has ${[...callerScopes].join(', ')}. ` +
            'Use a full-scope token, or ask the user to call it locally over stdio.',
        );
      }

      try {
        const result = await handler(args, { config, authInfo: caller, mode });
        audit({
          action: 'tool_call',
          tool: name,
          caller: callerName,
          mode,
          args: summarise(args),
          ok: result?.isError !== true,
          durationMs: Date.now() - startedAt,
        });
        return result;
      } catch (error) {
        audit({
          action: 'tool_error',
          tool: name,
          caller: callerName,
          mode,
          args: summarise(args),
          error: describeError(error),
          durationMs: Date.now() - startedAt,
        });
        return errorResult(describeError(error));
      }
    });
  };

  registerApiTools(register);
  registerShellTools(register);
  registerFsTools(register);
  registerSystemTools(register);
  registerPhoneTools(register);

  return server;
}
