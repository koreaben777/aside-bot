import Foundation
import Darwin
import Security

enum Platform:String,Codable,CaseIterable {case discord,slack}
struct Snapshot:Codable {
 struct Health:Codable {let state:String;let checkedAt:String?}
 let v:Int;let platform:Platform;let instanceId:String;let pid:Int32
 let phase:String;let stage:String;let errorCode:String?
 let preflightPassed:Bool;let engineStarted:Bool;let sleepDesired:Bool;let sleepActive:Bool;let asideHealth:Health
}
struct ControlReply:Decodable {let v:Int;let id:String;let ok:Bool;let code:String?;let status:Snapshot}
struct BotViewState {
 var phase="stopped",ownership="none"
 var snapshot:Snapshot?,lastReplyUptime:Double?,safeErrorCode:String?
}
enum QuitCompletion {case reply,terminate,stay}
struct QuitState {
 var waiting=false,readyToExit=false,pendingReply=false,wantsExit=true
 mutating func begin()->Bool {if readyToExit{return true};waiting=true;pendingReply=true;wantsExit=true;return false}
 mutating func timedOut(){pendingReply=false}
 mutating func finish()->QuitCompletion {
  waiting=false
  if pendingReply{pendingReply=false;readyToExit=true;return .reply}
  readyToExit=wantsExit;return wantsExit ? .terminate:.stay
 }
 mutating func fail()->Bool {waiting=false;readyToExit=false;let hadReply=pendingReply;pendingReply=false;return hadReply}
}
enum MenuState {case normal,progress,stopped,warning}
func aggregate(_ bots:[Platform:BotViewState])->MenuState {
 let states=Platform.allCases.map{bots[$0]?.phase ?? "unknown"}
 if states.allSatisfy({$0=="connected"}) && bots.values.allSatisfy({$0.safeErrorCode==nil}){return .normal}
 if states.contains(where:{$0=="error"||$0=="unknown"})||bots.values.contains(where:{$0.safeErrorCode != nil}){return .warning}
 if states.allSatisfy({$0=="stopped"}){return .stopped}
 if states.contains("stopped"){return .warning}
 return .progress
}
func isStale(lastReply:Double?,now:Double)->Bool {lastReply.map{now-$0>=6} ?? true}
final class MenuSettings {
 let defaults:UserDefaults
 init(_ defaults:UserDefaults = .standard){self.defaults=defaults;defaults.register(defaults:["autoStartBots":false,"preventIdleSleep":true,"launchAtLoginRequested":false])}
 var projectPath:String {get{defaults.string(forKey:"projectPath") ?? ""}set{defaults.set(newValue,forKey:"projectPath")}}
 var autoStartBots:Bool {get{defaults.bool(forKey:"autoStartBots")}set{defaults.set(newValue,forKey:"autoStartBots")}}
 var preventIdleSleep:Bool {get{defaults.bool(forKey:"preventIdleSleep")}set{defaults.set(newValue,forKey:"preventIdleSleep")}}
 var launchAtLoginRequested:Bool {get{defaults.bool(forKey:"launchAtLoginRequested")}set{defaults.set(newValue,forKey:"launchAtLoginRequested")}}
 var slackOverride:String? {get{defaults.string(forKey:"slackThreadAutoReplyOverride")}set{defaults.set(newValue,forKey:"slackThreadAutoReplyOverride")}}
}
let safeStages:Set<String>=["bootstrap","config","lock","owner","keychain","aside","platform","preflight","engine","shutdown"]
let safeCodes:Set<String>=["starting","connected","reconnecting","stopping","stopped","unknown","invalid_request","not_owner","owner_exists","invalid_owner","instance_mismatch","socket_path_too_long","control_unavailable","owner_timeout","config_invalid","keychain_unavailable","aside_unavailable","platform_unavailable","preflight_failed","service_already_running","invalid_service_lock","sleep_unavailable","shutdown_pending","identity_unknown","launchagent_conflict","build_missing","start_failed","process_exited"]
func appendSafeEvent(platform:Platform,code:String,stage:String,folder:URL?=nil) {
 guard safeCodes.contains(code),safeStages.contains(stage) else {return}
 let fm=FileManager.default,dir=folder ?? fm.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/AsideBotMenu/Logs")
 do {
  try fm.createDirectory(at:dir,withIntermediateDirectories:true,attributes:[.posixPermissions:0o700]);let path=dir.appendingPathComponent(platform.rawValue+".log").path
  var st=stat();if lstat(path,&st)==0 {guard st.st_uid==getuid(),st.st_mode & S_IFMT == S_IFREG else{return};if st.st_size>=1048576 {let old=path+".1";if fm.fileExists(atPath:old){try fm.removeItem(atPath:old)};try fm.moveItem(atPath:path,toPath:old)}}
  let fd=Darwin.open(path,O_WRONLY|O_CREAT|O_APPEND|O_NOFOLLOW|O_CLOEXEC,0o600);guard fd>=0 else{return};defer{Darwin.close(fd)};guard fstat(fd,&st)==0,st.st_uid==getuid(),st.st_mode & S_IFMT == S_IFREG else{return};fchmod(fd,0o600)
  let data=try JSONSerialization.data(withJSONObject:["time":ISO8601DateFormatter().string(from:Date()),"platform":platform.rawValue,"code":code,"stage":stage]);var line=data;line.append(10);line.withUnsafeBytes{_ = Darwin.write(fd,$0.baseAddress,line.count)}
 }catch{/* Fixed events only; never log a raw exception. */}
}
final class AppInstanceLock {
 private let fd:Int32
 init(folder:URL)throws {
  try FileManager.default.createDirectory(at:folder,withIntermediateDirectories:true,attributes:[.posixPermissions:0o700])
  fd=Darwin.open(folder.appendingPathComponent("manager.lock").path,O_RDWR|O_CREAT|O_NOFOLLOW|O_CLOEXEC,0o600)
  var st=stat();guard fd>=0,fstat(fd,&st)==0,st.st_uid==getuid(),st.st_mode & S_IFMT==S_IFREG,flock(fd,LOCK_EX|LOCK_NB)==0 else {if fd>=0{Darwin.close(fd)};throw ManagerError("service_already_running")}
 }
 deinit{Darwin.close(fd)}
}
// All socket IO is on a private queue with finite deadlines, never on AppKit's thread.
final class ControlChannel:@unchecked Sendable {
 private let queue=DispatchQueue(label:"aside.control.\(UUID())")
 private var fd:Int32 = -1
 private var buffer=Data()
 let expectedPID:Int32
 init(path:String,pid:Int32)throws {
  expectedPID=pid
  guard path.utf8.count<=103 else{throw ManagerError("socket_path_too_long")}
  var st=stat();guard lstat(path,&st)==0,st.st_uid==getuid(),st.st_mode & S_IFMT==S_IFSOCK,st.st_mode & 0o777==0o600 else{throw ManagerError("control_unavailable")}
  fd=Darwin.socket(AF_UNIX,SOCK_STREAM,0);guard fd>=0 else{throw ManagerError("control_unavailable")}
  do{
   _ = fcntl(fd,F_SETFD,FD_CLOEXEC);var noSignal:Int32=1;setsockopt(fd,SOL_SOCKET,SO_NOSIGPIPE,&noSignal,socklen_t(MemoryLayout.size(ofValue:noSignal)))
   var timeout=timeval(tv_sec:2,tv_usec:0);setsockopt(fd,SOL_SOCKET,SO_RCVTIMEO,&timeout,socklen_t(MemoryLayout.size(ofValue:timeout)));setsockopt(fd,SOL_SOCKET,SO_SNDTIMEO,&timeout,socklen_t(MemoryLayout.size(ofValue:timeout)))
   var address=sockaddr_un();address.sun_family=sa_family_t(AF_UNIX);address.sun_len=UInt8(MemoryLayout.size(ofValue:address))
   let name=Array(path.utf8CString);withUnsafeMutablePointer(to:&address.sun_path){$0.withMemoryRebound(to:CChar.self,capacity:104){p in for i in name.indices{p[i]=name[i]}}}
   let flags=fcntl(fd,F_GETFL);_ = fcntl(fd,F_SETFL,flags|O_NONBLOCK)
   let addressSize=socklen_t(MemoryLayout.size(ofValue:address))
   let result=withUnsafePointer(to:&address){$0.withMemoryRebound(to:sockaddr.self,capacity:1){Darwin.connect(fd,$0,addressSize)}}
   if result != 0 {guard errno==EINPROGRESS else{throw ManagerError("control_unavailable")};var pollFD=pollfd(fd:fd,events:Int16(POLLOUT),revents:0);guard poll(&pollFD,1,2000)>0 else{throw ManagerError("control_unavailable")};var error:Int32=0,length=socklen_t(MemoryLayout<Int32>.size);guard getsockopt(fd,SOL_SOCKET,SO_ERROR,&error,&length)==0,error==0 else{throw ManagerError("control_unavailable")}}
   _ = fcntl(fd,F_SETFL,flags)
   var uid:uid_t=0,gid:gid_t=0,peer:Int32=0,length=socklen_t(MemoryLayout<Int32>.size)
   guard getpeereid(fd,&uid,&gid)==0,uid==getuid(),getsockopt(fd,SOL_LOCAL,LOCAL_PEERPID,&peer,&length)==0,peer==pid else{throw ManagerError("identity_unknown")}
  }catch{Darwin.close(fd);fd = -1;throw error}
 }
 deinit{if fd>=0{Darwin.close(fd)}}
 func close() async {await withCheckedContinuation{continuation in queue.async{if self.fd>=0{Darwin.shutdown(self.fd,SHUT_RDWR);Darwin.close(self.fd);self.fd = -1};continuation.resume()}}}
 func request(_ fields:[String:Any]) async throws -> ControlReply {
  let id=UUID().uuidString;var payload=fields;payload["v"]=1;payload["id"]=id
  var bytes=try JSONSerialization.data(withJSONObject:payload);bytes.append(10)
  return try await withCheckedThrowingContinuation{continuation in queue.async{
   do {
    guard self.fd>=0 else{throw ManagerError("control_unavailable")}
    var sent=0;while sent<bytes.count {let n=bytes.withUnsafeBytes{Darwin.write(self.fd,$0.baseAddress!.advanced(by:sent),bytes.count-sent)};guard n>0 else{throw ManagerError("control_unavailable")};sent+=n}
    while !self.buffer.contains(10) {var chunk=[UInt8](repeating:0,count:4096);let n=Darwin.read(self.fd,&chunk,chunk.count);guard n>0 else{throw ManagerError("control_unavailable")};self.buffer.append(contentsOf:chunk.prefix(n));guard self.buffer.count<=16384 else{throw ManagerError("invalid_request")}}
    let end=self.buffer.firstIndex(of:10)!;let line=self.buffer.prefix(upTo:end);self.buffer.removeSubrange(...end)
    let reply=try JSONDecoder().decode(ControlReply.self,from:line)
    guard reply.v==1,reply.id==id,reply.status.v==1,reply.status.pid==self.expectedPID,safeStages.contains(reply.status.stage),["starting","connected","reconnecting","stopping","error"].contains(reply.status.phase),reply.status.errorCode.map(safeCodes.contains) ?? true,reply.status.phase != "connected" || (reply.status.preflightPassed && reply.status.engineStarted) else{throw ManagerError("invalid_request")}
    continuation.resume(returning:reply)
   }catch{if self.fd>=0{Darwin.close(self.fd);self.fd = -1};continuation.resume(throwing:ManagerError((error as? ManagerError)?.code ?? "invalid_request"))}
  }}
 }
}

typealias ServiceDiscovery = @Sendable (URL) async throws -> [String]

func makeMenuRefreshTimer(interval:TimeInterval=2, tick:@escaping @Sendable ()->Void)->Timer {
 let timer=Timer(timeInterval:interval,repeats:true){_ in tick()}
 RunLoop.main.add(timer,forMode:.common)
 return timer
}

@MainActor final class BotController {
 private let discoverServices:ServiceDiscovery
 let projectURL:URL,nodeURL:URL
 var preventSleep:Bool
 var slackOverride:String?
 private let logDirectory:URL?
 var onChange:(()->Void)?
 private(set) var bots:[Platform:BotViewState]=[.discord:BotViewState(),.slack:BotViewState()]
 private var processes:[Platform:Process]=[:],identities:[Platform:ProcessIdentity]=[:],channels:[Platform:ControlChannel]=[:]
 private var instanceIDs:[Platform:String]=[:],directories:[Platform:URL]=[:]
 private var preparing:Process?,starting=false,stopping=false,refreshing=false,startCancelled=false
 private var stopTask:Task<Void,Error>?
 private(set) var conflict=false
 init(projectURL:URL,nodeURL:URL,preventSleep:Bool,logDirectory:URL?=nil,discoverServices:@escaping ServiceDiscovery={project in try await Task.detached{try findConflictingServices(project:project)}.value}){self.discoverServices=discoverServices;self.logDirectory=logDirectory;self.projectURL=projectURL.resolvingSymlinksInPath();self.nodeURL=nodeURL.resolvingSymlinksInPath();self.preventSleep=preventSleep}
 private var environment:[String:String]{
  var env=["HOME":FileManager.default.homeDirectoryForCurrentUser.path,"PATH":"/usr/bin:/bin:/usr/sbin:/sbin","LANG":"en_US.UTF-8"]
  if let tmp=ProcessInfo.processInfo.environment["TMPDIR"]{env["TMPDIR"]=tmp}
  if let override=slackOverride,override=="true"||override=="false"{env["ASIDE_SLACK_THREAD_AUTO_REPLY"]=override}
  return env
 }
 private func paths()throws {
  let fm=FileManager.default
  guard fm.isExecutableFile(atPath:nodeURL.path),fm.fileExists(atPath:projectURL.appendingPathComponent("dist/scripts/prepare-bots.js").path),Platform.allCases.allSatisfy({fm.fileExists(atPath:entry($0).path)}) else{throw ManagerError("build_missing")}
  let json=try JSONSerialization.jsonObject(with:Data(contentsOf:projectURL.appendingPathComponent("config.local.json"))) as? [String:Any]
  guard let path=json?["dataDir"] as? String,path.hasPrefix("/") else{throw ManagerError("config_invalid")}
  guard fm.fileExists(atPath:projectURL.appendingPathComponent("config.slack.local.json").path) else{throw ManagerError("config_invalid")}
  directories=[.discord:URL(fileURLWithPath:canonical(path)),.slack:URL(fileURLWithPath:canonical(path)).appendingPathComponent("slack")]
 }
 private func entry(_ platform:Platform)->URL{projectURL.appendingPathComponent(platform == .discord ? "dist/src/main.js":"dist/src/slack/main.js")}
 private func identityMatches(_ identity:ProcessIdentity,entry:URL)->Bool {
  guard identity.uid==getuid(),identity.executable==canonical(nodeURL.path),identity.workingDirectory==canonical(projectURL.path),identity.arguments.count==2 else{return false}
  let argument=identity.arguments[1];let path=argument.hasPrefix("/") ? argument:projectURL.appendingPathComponent(argument).path
  return canonical(path)==canonical(entry.path)
 }
 private func lockIdentity(_ platform:Platform)throws -> ProcessIdentity? {
  guard let dir=directories[platform] else{throw ManagerError("config_invalid")}
  let path=dir.appendingPathComponent("service.lock").path;var st=stat()
  if lstat(path,&st) != 0 {if errno==ENOENT{return nil};throw ManagerError("invalid_service_lock")}
  guard st.st_uid==getuid(),st.st_mode & S_IFMT==S_IFREG else{throw ManagerError("invalid_service_lock")}
  let fd=Darwin.open(path,O_RDONLY|O_NOFOLLOW|O_CLOEXEC);guard fd>=0 else{throw ManagerError("invalid_service_lock")};defer{Darwin.close(fd)}
  var actual=stat();guard fstat(fd,&actual)==0,actual.st_uid==getuid(),actual.st_ino==st.st_ino,actual.st_mode & S_IFMT==S_IFREG else{throw ManagerError("invalid_service_lock")}
  var bytes=[UInt8](repeating:0,count:64);let count=Darwin.read(fd,&bytes,bytes.count)
  guard count>0,count<64,let value=String(bytes:bytes.prefix(count),encoding:.utf8) else{throw ManagerError("invalid_service_lock")}
  let text=value.trimmingCharacters(in:.whitespacesAndNewlines)
  guard !text.isEmpty,text.allSatisfy({$0.isASCII && $0.isNumber}),let pid=Int32(text),pid>0 else{throw ManagerError("invalid_service_lock")}
  guard let identity=try inspectProcess(pid) else{return nil}
  guard identityMatches(identity,entry:entry(platform)) else{throw ManagerError("identity_unknown")};return identity
 }
 private func process(_ entry:URL)->Process {
  let p=Process();p.executableURL=nodeURL;p.arguments=[entry.path];p.currentDirectoryURL=projectURL;p.environment=environment
  for stderr in [false,true] {let pipe=Pipe();pipe.fileHandleForReading.readabilityHandler={h in if h.availableData.isEmpty{h.readabilityHandler=nil}};if stderr{p.standardError=pipe}else{p.standardOutput=pipe}}
  return p
 }
 private func connectChannel(_ platform:Platform,pid:Int32) async throws -> ControlChannel {
  let path=directories[platform]!.appendingPathComponent("control.sock").path
  return try await Task.detached {try ControlChannel(path:path,pid:pid)}.value
 }
 private func accept(_ reply:ControlReply,platform:Platform)throws {
  guard reply.status.platform==platform,instanceIDs[platform].map({$0==reply.status.instanceId}) ?? true else{throw ManagerError("instance_mismatch")}
  if bots[platform]?.phase != reply.status.phase || bots[platform]?.safeErrorCode != reply.status.errorCode {appendSafeEvent(platform:platform,code:reply.status.errorCode ?? reply.status.phase,stage:reply.status.stage,folder:logDirectory)}
  instanceIDs[platform]=reply.status.instanceId
  var state=bots[platform] ?? BotViewState();state.snapshot=reply.status;state.phase=stopping && state.ownership=="managed" ? "stopping":reply.status.phase;state.lastReplyUptime=ProcessInfo.processInfo.systemUptime;state.safeErrorCode=reply.status.errorCode;bots[platform]=state
 }
 func refresh() async {
  guard !refreshing else{return};refreshing=true;defer{refreshing=false;onChange?()}
  do{try paths();conflict = !(try await discoverServices(projectURL)).isEmpty}catch{for platform in Platform.allCases{var state=bots[platform] ?? BotViewState();state.phase="unknown";state.lastReplyUptime=nil;state.safeErrorCode=(error as? ManagerError)?.code ?? "config_invalid";bots[platform]=state};return}
  for platform in Platform.allCases {
   if let child=processes[platform],!child.isRunning{await childExited(platform);continue}
   if processes[platform]==nil {
    do{
     if let identity=try lockIdentity(platform){bots[platform]?.ownership="external";bots[platform]?.phase="unknown"
      if channels[platform]?.expectedPID != identity.pid {await channels[platform]?.close();channels[platform]=try? await connectChannel(platform,pid:identity.pid);instanceIDs[platform]=nil}
     }else{await channels[platform]?.close();channels[platform]=nil;instanceIDs[platform]=nil;bots[platform]=BotViewState();continue}
    }catch{await channels[platform]?.close();channels[platform]=nil;bots[platform]=BotViewState(phase:"unknown",ownership:"external",safeErrorCode:(error as? ManagerError)?.code ?? "identity_unknown");continue}
   }
   if let channel=channels[platform] {do{try accept(await channel.request(["op":"status"]),platform:platform)}catch{await channel.close();if processes[platform]==nil{channels[platform]=nil;instanceIDs[platform]=nil};if isStale(lastReply:bots[platform]?.lastReplyUptime,now:ProcessInfo.processInfo.systemUptime){bots[platform]?.phase="unknown"};bots[platform]?.safeErrorCode=(error as? ManagerError)?.code ?? "control_unavailable"}}
  }
 }
 func invalidate(){for platform in Platform.allCases where bots[platform]?.phase != "stopped"{bots[platform]?.phase="unknown";bots[platform]?.lastReplyUptime=nil};onChange?()}
 func startBoth() async throws {
  guard !starting,!stopping,processes.isEmpty else{throw ManagerError("service_already_running")}
  starting=true;startCancelled=false;defer{starting=false;onChange?()}
  do{
   try paths();guard (try await discoverServices(projectURL)).isEmpty else{throw ManagerError("launchagent_conflict")}
   guard !startCancelled else{throw ManagerError("shutdown_pending")}
   for platform in Platform.allCases {guard try lockIdentity(platform)==nil else{throw ManagerError("service_already_running")}}
   for platform in Platform.allCases{bots[platform]=BotViewState(phase:"starting",ownership:"managed")};onChange?()
   let prep=process(projectURL.appendingPathComponent("dist/scripts/prepare-bots.js"));preparing=prep;try prep.run();while prep.isRunning{try await Task.sleep(nanoseconds:100000000)};preparing=nil
   guard !startCancelled,prep.terminationStatus==0 else{throw ManagerError("aside_unavailable")}
   for platform in Platform.allCases {
    guard !startCancelled else{throw ManagerError("shutdown_pending")}
    var random=[UInt8](repeating:0,count:32);guard SecRandomCopyBytes(kSecRandomDefault,random.count,&random)==errSecSuccess else{throw ManagerError("invalid_owner")};let token=random.map{String(format:"%02x",$0)}.joined()
    let child=process(entry(platform));var env=environment;env["ASIDE_MENU_MANAGED"]="1";child.environment=env;let input=Pipe();child.standardInput=input
    child.terminationHandler={ [weak self] _ in Task{@MainActor in await self?.childExited(platform)}}
    try child.run();processes[platform]=child
    guard let launched=try inspectProcess(child.processIdentifier),launched.parentPID==getpid(),identityMatches(launched,entry:entry(platform)) else{throw ManagerError("identity_unknown")};identities[platform]=launched
    let bootstrap=try JSONSerialization.data(withJSONObject:["v":1,"token":token,"sleepEnabled":preventSleep]);var line=bootstrap;line.append(10);try input.fileHandleForWriting.write(contentsOf:line);try input.fileHandleForWriting.close()
    let deadline=ProcessInfo.processInfo.systemUptime+9
    var channel:ControlChannel?
    while channel==nil&&ProcessInfo.processInfo.systemUptime<deadline&&child.isRunning && !startCancelled {channel=try? await connectChannel(platform,pid:child.processIdentifier);if channel==nil{try await Task.sleep(nanoseconds:50000000)}}
    guard !startCancelled,let channel else{throw ManagerError("control_unavailable")};channels[platform]=channel
    guard let identity=try inspectProcess(child.processIdentifier),identityMatches(identity,entry:entry(platform)) else{throw ManagerError("identity_unknown")};identities[platform]=identity
    let status=try await channel.request(["op":"status"]);try accept(status,platform:platform);instanceIDs[platform]=status.status.instanceId
    guard child.isRunning,try inspectProcess(child.processIdentifier).map({sameProcess(identity,$0)})==true else{throw ManagerError("identity_unknown")}
    guard !startCancelled else{throw ManagerError("shutdown_pending")}
    let claimed=try await channel.request(["op":"claim","instanceId":status.status.instanceId,"token":token]);guard claimed.ok else{throw ManagerError(claimed.code ?? "invalid_owner")};try accept(claimed,platform:platform)
   }
   guard processes.count==2,processes.values.allSatisfy({$0.isRunning}) else{throw ManagerError("process_exited")}
  }catch{starting=false;await stopBothIgnoringFailure();for platform in Platform.allCases{bots[platform]?.safeErrorCode=(error as? ManagerError)?.code ?? "start_failed"};throw error}
 }
 private func childExited(_ platform:Platform) async {
  guard let child=processes[platform],!child.isRunning else{return}
  await channels[platform]?.close();channels[platform]=nil;processes[platform]=nil;identities[platform]=nil;instanceIDs[platform]=nil
  bots[platform]=BotViewState(phase:"stopped",safeErrorCode:stopping ? nil:"process_exited");appendSafeEvent(platform:platform,code:"stopped",stage:"shutdown",folder:logDirectory);onChange?()
  if !stopping && !starting && !processes.isEmpty {await stopBothIgnoringFailure()}
 }
 private func stopBothIgnoringFailure() async {try? await stopBoth()}
 func stopBoth() async throws {
  if let task=stopTask{return try await task.value}
  stopping=true;startCancelled=true;preparing?.terminate();for platform in processes.keys{bots[platform]?.phase="stopping"};onChange?()
  let task=Task{@MainActor in
   for platform in Platform.allCases {
    guard let child=self.processes[platform],child.isRunning else{continue}
    if let channel=self.channels[platform],let instance=self.instanceIDs[platform] {let accepted=try? await channel.request(["op":"shutdown","instanceId":instance]);if accepted?.ok != true{await channel.close()}}
    else {guard let saved=self.identities[platform],let identity=try inspectProcess(child.processIdentifier),sameProcess(saved,identity),self.identityMatches(identity,entry:self.entry(platform)) else{throw ManagerError("identity_unknown")};guard let again=try inspectProcess(identity.pid),sameProcess(identity,again) else{throw ManagerError("identity_unknown")};kill(identity.pid,SIGTERM)}
   }
   while self.starting||self.preparing?.isRunning==true||self.processes.values.contains(where:{$0.isRunning}) {try await Task.sleep(nanoseconds:100000000)}
   for platform in Platform.allCases{await self.childExited(platform)}
  };stopTask=task
  do{try await task.value;stopTask=nil;stopping=false;onChange?()}catch{stopTask=nil;for platform in processes.keys{bots[platform]?.phase="error";bots[platform]?.safeErrorCode="shutdown_pending"};onChange?();throw error}
 }
 func setSleep(_ enabled:Bool) async {
  preventSleep=enabled
  for platform in Platform.allCases {
   guard bots[platform]?.ownership=="managed",let channel=channels[platform],let instance=instanceIDs[platform] else{continue}
   do{let reply=try await channel.request(["op":"setSleep","instanceId":instance,"enabled":enabled]);try accept(reply,platform:platform);if !reply.ok{bots[platform]?.safeErrorCode=reply.code ?? "sleep_unavailable"}}catch{await channel.close();bots[platform]?.safeErrorCode="sleep_unavailable"}
  };onChange?()
 }
 func takeOver() async throws {
  guard !starting,!stopping,processes.isEmpty else{throw ManagerError("service_already_running")}
  starting=true;startCancelled=false;defer{starting=false;onChange?()}
  try paths()
  guard (try await discoverServices(projectURL)).isEmpty else{throw ManagerError("launchagent_conflict")}
  guard !startCancelled else{throw ManagerError("shutdown_pending")}
  var targets=[ProcessIdentity](),children=[ProcessIdentity]()
  for platform in Platform.allCases {
   guard let child=try lockIdentity(platform) else{continue};children.append(child)
   guard let parent=try inspectProcess(child.parentPID) else{throw ManagerError("identity_unknown")}
   if identityMatches(parent,entry:projectURL.appendingPathComponent("scripts/start-bots.mjs")){if !targets.contains(parent){targets.append(parent)}}
   else if ["/bin/bash","/bin/zsh","/bin/sh"].contains(parent.executable){targets.append(child)}
   else{throw ManagerError("identity_unknown")}
  }
  guard !targets.isEmpty else{throw ManagerError("identity_unknown")}
  for target in targets {guard !startCancelled else{throw ManagerError("shutdown_pending")};guard let current=try inspectProcess(target.pid),sameProcess(target,current) else{throw ManagerError("identity_unknown")};guard kill(target.pid,SIGTERM)==0 else{throw ManagerError("identity_unknown")}}
  let deadline=ProcessInfo.processInfo.systemUptime+30
  for target in targets+children {while let current=try inspectProcess(target.pid),sameProcess(target,current){guard !startCancelled,ProcessInfo.processInfo.systemUptime<deadline else{throw ManagerError("shutdown_pending")};try await Task.sleep(nanoseconds:100000000)}}
  guard !startCancelled else{throw ManagerError("shutdown_pending")};starting=false;try await startBoth()
 }
}
