import { McpServer } from '@modelcontextprotocol/server';
import { audit } from './audit.js';
import { describeError, errorResult } from './result.js';
import { registerApiTools } from './tools/api.js';
import { registerFsTools } from './tools/fs.js';
import { registerPhoneTools } from './tools/phone.js';
import { registerPhoneComboTools } from './tools/phone-combo.js';
import { registerShellTools } from './tools/shell.js';
import { registerShellExtraTools } from './tools/shell-extra.js';
import { registerPhoneRebootTools } from './tools/phone-reboot.js';
import { registerSystemTools } from './tools/system.js';

export const SERVER_NAME = 'termux-mcp';

const INSTRUCTIONS = `Control the Android device this Termux install is running on.

Grouping:
- shell, shell_bg, shell_jobs, shell_logs, shell_kill run commands in the Termux shell.
- fs_* read and write files, but only inside the configured allowed roots.
- location, screenshot, camera_photo, mic_record, notification, dialog, toast,
  share, sms_*, wifi_scan and api_run drive the Android APIs through termux-api.
- 배터리·와이파이 정보·진동·음성 읽기·센서는 써니 앱 네이티브 도구를 쓴다(빠름): phone_battery_status,
  phone_wifi_info, phone_vibrate, phone_tts_speak, phone_sensor_list, phone_sensor_read.
- system_info, proc_*, pkg_*, storage_info, network_info, audit_tail report device state.
- phone_* drive the screen through the Sunny Phone Control app (accessibility): phone_get_screen_state
  reads any app's UI, phone_tap/phone_click_node/phone_type_* act on it, phone_notification_* handle
  notifications, phone_open_app/phone_send_intent launch apps. phone_status checks the app.


실전 규칙 (휴대폰 조작 요청, 2026-10-30 추가 — 도구별 세부 규칙은 각 phone_* 설명문 끝 [실전 규칙]):
- 결과를 말할 때 '명령 전달 성공'과 '화면에서 확인한 결과'를 구분한다. 화면 확인은 phone_get_screen_state.
- 곡·영상 재생 요청: phone_youtube_play. 특정 영상을 원하거나 정확도가 중요하면 웹 검색으로 video_id(watch?v= 뒤 11자)를 찾아 넘긴다.
  유튜브 재생 규칙(2026-10-30, 이전 규칙 대체): ① 신호를 받으면 화면 조작을 일시 멈추고 음성 통화를 종료 ② 미디어 재생 제어로 재생
  ③ 미디어 재생 상태 조회로 재생 시간이 늘어나는지 확인 ④ 안 늘어나면 미디어 재생 제어로 재생 신호를 다시 보냄 — 도구가 직접 수행한다.
  이 과정에서 화면 조회·화면 탭·버튼 누르기는 하지 않는다. 결과의 [재생 확인됨]일 때만 '재생 중'이라고 말한다.
- 앱 열기: phone_open_app(package_id). 패키지 이름을 모르면 phone_list_apps(name_query)로 찾는다.
- 화면 조작 순서: phone_get_screen_state로 요소 확인 → phone_click_node → 안 되면 phone_tap_node → 마지막에 좌표 phone_tap
  → 다시 phone_get_screen_state로 확인.
- 글자 입력: phone_type_append_text(칸 지정) → 검색은 phone_press_key(ENTER).
- 설정 화면 등은 shell의 am start보다 phone_send_intent가 확실하다(Termux는 백그라운드에서 화면을 못 띄울 때가 있다).
- 잠금 화면이면 조작하지 말고 사용자에게 잠금 해제를 부탁한다. Termux·Sunny Phone Control 알림은 지우지 않는다.
- 클립보드는 phone_get_clipboard(읽기) / phone_set_clipboard(쓰기)만 쓴다. Termux 클립보드 도구는 없다
  (안드로이드가 뒤에서 도는 Termux의 클립보드 읽기를 막아 빈 값만 나왔기 때문에 2026-10-30 제거).
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

  // 2026-10-30: 써니 폰 컨트롤 앱에 네이티브로 옮겨 더 빠르고 기능이 같거나 나은 Termux:API 도구는 목록에서 뺀다.
  // (실측: 써니 50~80ms, Termux:API 1~2초) 대신 phone_<이름>을 쓴다. 되돌리려면 이 집합에서 이름을 지운다.
  const MOVED_TO_SUNNY = new Set(['vibrate', 'sensor_list', 'sensor_read', 'tts_speak', 'battery_status', 'wifi_info']);

  const register = (name, definition, handler) => {
    if (MOVED_TO_SUNNY.has(name)) return;
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
  registerShellExtraTools(register);
  registerPhoneRebootTools(register);
  registerFsTools(register);
  registerSystemTools(register);
  registerPhoneTools(register);
  registerPhoneComboTools(register);

  return server;
}
