import AppKit
import ServiceManagement

private let descriptions:[String:String]=[
 "starting":"시작 중","connected":"연결됨","reconnecting":"재연결 중","stopping":"종료 중","stopped":"중지됨","unknown":"확인 불가","error":"오류",
 "config_invalid":"프로젝트 경로와 양쪽 설정 파일을 확인하세요.","build_missing":"Node 또는 빌드 결과가 없습니다. 프로젝트에서 앱 빌드를 실행하세요.","identity_unknown":"실행 식별 정보가 불명확합니다. 자동 인계를 중단했습니다.","launchagent_conflict":"LaunchAgent가 발견되었습니다. 별도의 운영 절차로 확인하세요.","service_already_running":"이미 실행 중이거나 다른 작업이 진행 중입니다.","invalid_service_lock":"잠금을 확인할 수 없어 보존했습니다.","control_unavailable":"로컬 제어 연결을 확인할 수 없습니다.","socket_path_too_long":"데이터 경로가 너무 깁니다. 더 짧은 경로가 필요합니다.","keychain_unavailable":"Keychain 토큰을 확인하세요.","aside_unavailable":"Aside 설치·로그인·연결을 확인하세요.","platform_unavailable":"플랫폼 연결을 확인하세요.","preflight_failed":"계정과 채널 권한 검증에 실패했습니다.","sleep_unavailable":"절전방지 설정을 일부 적용하지 못했습니다.","shutdown_pending":"프로세스 종료를 확인하지 못했습니다. 기다리거나 운영 상태를 확인하세요.","process_exited":"봇이 예기치 않게 종료되었습니다.","start_failed":"시작하지 못했습니다. 설정과 연결을 확인하세요.","owner_timeout":"관리 연결 제한 시간이 지났습니다.","invalid_owner":"관리 연결을 인증하지 못했습니다.","instance_mismatch":"실행 인스턴스가 바뀌었습니다. 상태를 다시 확인하세요."
]
@MainActor final class AppDelegate:NSObject,NSApplicationDelegate {
 private let settings=MenuSettings()
 private var lock:AppInstanceLock?,controller:BotController?,item:NSStatusItem!,poll:Timer?
 private var quitState=QuitState()
 private var quitting:Bool{quitState.waiting}
 func applicationDidFinishLaunching(_ notification:Notification){
  do{lock=try AppInstanceLock(folder:FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/AsideBotMenu"))}catch{NSApp.terminate(nil);return}
  item=NSStatusBar.system.statusItem(withLength:NSStatusItem.variableLength)
  configureController();render()
  poll=makeMenuRefreshTimer { [weak self] in Task{@MainActor in await self?.controller?.refresh()}}
  NSWorkspace.shared.notificationCenter.addObserver(self,selector:#selector(wake),name:NSWorkspace.didWakeNotification,object:nil)
  if settings.autoStartBots,controller != nil{Task{await action{try await self.controller?.startBoth()}}}
 }
 private func configureController(){
  guard !settings.projectPath.isEmpty else{return}
  let node=FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".aside/runtime/node/bin/node")
  let c=BotController(projectURL:URL(fileURLWithPath:settings.projectPath),nodeURL:node,preventSleep:settings.preventIdleSleep);c.slackOverride=settings.slackOverride
  c.onChange={ [weak self] in self?.render()};controller=c;Task{await c.refresh()}
 }
 @discardableResult private func add(_ menu:NSMenu,_ title:String,_ selector:Selector?=nil,checked:Bool=false,enabled:Bool=true)->NSMenuItem {
  let m=NSMenuItem(title:title,action:selector,keyEquivalent:"");m.target=self;m.isEnabled=enabled;m.state=checked ? .on:.off;menu.addItem(m);return m
 }
 private func render(){
  guard item != nil else{return};let bots=controller?.bots ?? [.discord:BotViewState(),.slack:BotViewState()];let state=aggregate(bots)
  let icon:String,label:String
  switch state {case .normal:icon="checkmark.circle.fill";label="두 봇 연결됨";case .progress:icon="arrow.triangle.2.circlepath";label="봇 상태 전환 중";case .stopped:icon="stop.circle";label="두 봇 중지됨";case .warning:icon="exclamationmark.triangle";label="봇 상태 확인 필요"}
  let image=NSImage(systemSymbolName:icon,accessibilityDescription:label);image?.isTemplate=true;item.button?.image=image;item.button?.setAccessibilityLabel(label);item.button?.toolTip=label
  let menu=NSMenu();menu.autoenablesItems=false
  for p in Platform.allCases {let s=bots[p]!;add(menu,"\(p == .discord ? "Discord":"Slack"): \(descriptions[s.phase] ?? "확인 불가")",enabled:false)}
  let external=bots.values.contains{$0.ownership=="external"}
  add(menu,controller?.conflict==true ? "관리: LaunchAgent 확인 필요":external ? "관리: 외부 실행 관찰 중":"관리: 메뉴 바 앱",enabled:false);menu.addItem(.separator())
  add(menu,"두 봇 시작",#selector(start),enabled:controller != nil && !quitting)
  add(menu,"관리 봇 정상 중지",#selector(stop),enabled:controller != nil)
  add(menu,"외부 실행 인계…",#selector(takeOver),enabled:external && controller?.conflict != true && !quitting);menu.addItem(.separator())
  add(menu,"자동 유휴 잠자기 방지",#selector(toggleSleep),checked:settings.preventIdleSleep)
  for p in Platform.allCases {let s=bots[p]!.snapshot;add(menu,"\(p.rawValue): 실제 절전방지 \(s.map{$0.sleepActive ? "켜짐":"꺼짐"} ?? "미확인")",enabled:false)}
  menu.addItem(.separator());add(menu,"로그인 시 앱 실행",#selector(toggleLogin),checked:SMAppService.mainApp.status == .enabled)
  let login:String;switch SMAppService.mainApp.status{case .enabled:login="로그인 항목: 등록됨";case .requiresApproval:login="로그인 항목: 시스템 설정 승인 대기";case .notFound:login="로그인 항목: 앱 배치 확인 필요";case .notRegistered:login=settings.launchAtLoginRequested ? "로그인 항목: 미등록 (희망 켜짐)":"로그인 항목: 미등록";@unknown default:login="로그인 항목: 확인 불가"}
  add(menu,login,enabled:false);add(menu,"앱 실행 시 봇 자동 시작",#selector(toggleAuto),checked:settings.autoStartBots)
  add(menu,"프로젝트 폴더 선택…",#selector(chooseProject),enabled:bots.values.allSatisfy{$0.ownership != "managed"} && !quitting)
  let override=NSMenu();for (name,value) in [("설정 파일 사용",nil),("스레드 자동 응답 켜짐","true"),("스레드 자동 응답 꺼짐","false")] as [(String,String?)] {let m=add(override,name,#selector(setOverride),checked:settings.slackOverride==value);m.representedObject=value ?? "unset";m.isEnabled=bots.values.allSatisfy{$0.ownership != "managed"}}
  let overrides=add(menu,"Slack 스레드 자동 응답 (다음 시작)");overrides.submenu=override
  menu.addItem(.separator());add(menu,"상태·오류 상세…",#selector(details));add(menu,"Discord 안전 로그…",#selector(discordLog));add(menu,"Slack 안전 로그…",#selector(slackLog));menu.addItem(.separator())
  add(menu,"관리 봇 종료 후 앱 종료",#selector(quit));item.menu=menu
 }
 private func alert(_ text:String){let a=NSAlert();a.messageText=text;a.addButton(withTitle:"확인");a.runModal()}
 private func action(_ work:() async throws -> Void) async {do{try await work()}catch{alert(descriptions[(error as? ManagerError)?.code ?? "start_failed"] ?? "상태를 확인하세요.")};render()}
 @objc private func start(){if controller==nil{chooseProject();return};Task{await action{try await self.controller?.startBoth()}}}
 @objc private func stop(){Task{await action{try await self.controller?.stopBoth()}}}
 @objc private func takeOver(){
  let a=NSAlert();a.messageText="외부 실행을 정상 종료하고 앱 아래에서 다시 시작합니다.";a.informativeText="연결이 끊기고 실행 중인 요청에 중단을 요청할 수 있습니다. Slack 환경변수는 자동 추출하지 않습니다. 현재 설정 파일과 메뉴의 Slack 스레드 자동 응답 설정이 의도한 값인지 확인하세요. LaunchAgent와 불명확한 프로세스는 인계하지 않습니다.";a.addButton(withTitle:"인계");a.addButton(withTitle:"취소")
  if a.runModal() == .alertFirstButtonReturn{Task{await action{try await self.controller?.takeOver()}}}
 }
 @objc private func toggleSleep(){settings.preventIdleSleep.toggle();Task{await controller?.setSleep(settings.preventIdleSleep);render()}}
 @objc private func toggleAuto(){settings.autoStartBots.toggle();render()}
 @objc private func toggleLogin(){
  do{
   if SMAppService.mainApp.status == .enabled || SMAppService.mainApp.status == .requiresApproval {try SMAppService.mainApp.unregister();settings.launchAtLoginRequested=false}
   else{try SMAppService.mainApp.register();settings.launchAtLoginRequested=true;if SMAppService.mainApp.status == .requiresApproval {alert("시스템 설정의 로그인 항목에서 승인이 필요합니다.")}}
  }catch{alert("로그인 항목을 변경하지 못했습니다. 앱 배치와 시스템 설정을 확인하세요.")};render()
 }
 @objc private func chooseProject(){let panel=NSOpenPanel();panel.canChooseFiles=false;panel.canChooseDirectories=true;panel.allowsMultipleSelection=false;panel.message="config.local.json과 빌드 결과가 있는 프로젝트 폴더를 선택하세요.";if panel.runModal() == .OK,let url=panel.url{settings.projectPath=url.path;configureController();render()}}
 @objc private func setOverride(_ sender:NSMenuItem){let value=sender.representedObject as? String;settings.slackOverride=value=="unset" ? nil:value;controller?.slackOverride=settings.slackOverride;render()}
 @objc private func wake(){controller?.invalidate();Task{await controller?.refresh()}}
 @objc private func details(){
  var lines=["프로젝트: \(settings.projectPath.isEmpty ? "선택 필요":settings.projectPath)","Node: ~/.aside/runtime/node/bin/node"]
  for p in Platform.allCases {guard let s=controller?.bots[p] else{continue};lines.append("\(p.rawValue): \(descriptions[s.phase] ?? "확인 불가") / \(s.ownership=="managed" ? "앱 관리":s.ownership=="external" ? "외부 실행":"관리 없음")");if let code=s.safeErrorCode{lines.append(descriptions[code] ?? "로컬 제어 상태를 확인하세요.")};if let snapshot=s.snapshot{lines.append("Aside 마지막 점검: \(snapshot.asideHealth.state) / \(snapshot.asideHealth.checkedAt ?? "미점검") (현재 모델 응답 보장은 아님)")}}
  alert(lines.joined(separator:"\n"))
 }
 @objc private func discordLog(){showLog(.discord)}
 @objc private func slackLog(){showLog(.slack)}
 private func showLog(_ platform:Platform){
  if controller?.bots[platform]?.ownership=="external"{alert("외부 실행의 원문 로그는 수집하지 않습니다.");return}
  let url=FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/AsideBotMenu/Logs/\(platform.rawValue).log")
  do{let data=try Data(contentsOf:url);guard data.count<=1100000,let text=String(data:data,encoding:.utf8) else{throw ManagerError("invalid_request")}
   let lines=try text.split(separator:"\n").suffix(50).map{line -> String in
    guard let row=(try JSONSerialization.jsonObject(with:Data(line.utf8))) as? [String:String],Set(row.keys)==Set(["time","platform","code","stage"]),row["platform"]==platform.rawValue,let code=row["code"],safeCodes.contains(code),let stage=row["stage"],safeStages.contains(stage),let time=row["time"],ISO8601DateFormatter().date(from:time) != nil else{throw ManagerError("invalid_request")}
    return "\(time) · \(descriptions[code] ?? "상태 점검") · \(stage)"
   };alert(lines.isEmpty ? "기록된 안전 이벤트가 없습니다.":lines.joined(separator:"\n"))
  }catch{alert("안전 로그가 없거나 형식을 확인할 수 없습니다. 원문 로그는 표시하지 않습니다.")}
 }
 @objc private func quit(){NSApp.terminate(nil)}
 func applicationShouldTerminate(_ sender:NSApplication)->NSApplication.TerminateReply {
  if quitState.waiting{quitState.pendingReply=true;quitState.wantsExit=true;return .terminateLater}
  if quitState.begin(){return .terminateNow};render()
  let work=Task{try await controller?.stopBoth()}
  Task{
   do{try await work.value;switch quitState.finish(){case .reply:sender.reply(toApplicationShouldTerminate:true);case .terminate:sender.terminate(nil);case .stay:render()}}
   catch{if quitState.fail(){sender.reply(toApplicationShouldTerminate:false)};alert("종료를 확인하지 못했습니다. 앱을 유지합니다.");render()}
  }
  Task{try? await Task.sleep(nanoseconds:30000000000);guard quitting else{return};quitState.timedOut();sender.reply(toApplicationShouldTerminate:false)
   let a=NSAlert();a.messageText="봇 종료가 아직 확인되지 않았습니다.";a.informativeText="정리는 계속됩니다. 앱 종료 취소가 봇 재시작을 뜻하지 않습니다.";a.addButton(withTitle:"계속 기다리기");a.addButton(withTitle:"앱 종료 취소");quitState.wantsExit=a.runModal() == .alertFirstButtonReturn
  };return .terminateLater
 }
}
@main struct AsideBotMenuApp {static func main(){let app=NSApplication.shared;let delegate=AppDelegate();app.delegate=delegate;app.setActivationPolicy(.accessory);withExtendedLifetime(delegate){app.run()}}}
