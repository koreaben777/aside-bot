import Foundation
import AppKit
import CoreFoundation
import Darwin

@main struct Checks {
 @MainActor static func main() async throws {
  if CommandLine.arguments.contains("--tracking-regression") {try trackingRegression();print("menu tracking regression passed");return}
  if CommandLine.arguments.contains("--takeover-regression") {
   try await takeoverRegression(node:URL(fileURLWithPath:CommandLine.arguments[2]));print("takeover stop regression passed");return
  }
  try trackingRegression()
  let original=ProcessIdentity(pid:1,parentPID:2,uid:getuid(),startedAtMicros:1,executable:"/bin/node",arguments:["/bin/node","dist/src/main.js"],workingDirectory:"/tmp/한 글")
  let reused=ProcessIdentity(pid:1,parentPID:2,uid:getuid(),startedAtMicros:2,executable:"/bin/node",arguments:original.arguments,workingDirectory:original.workingDirectory)
  assert(!sameProcess(original,reused))
  let myself=try inspectProcess(getpid());assert(myself?.pid==getpid());assert(myself?.uid==getuid());assert(myself?.workingDirectory==canonical(FileManager.default.currentDirectoryPath))
  let missing=try inspectProcess(Int32.max);assert(missing==nil)
  assert(aggregate([.discord:BotViewState(phase:"connected"),.slack:BotViewState(phase:"connected")]) == .normal)
  assert(aggregate([.discord:BotViewState(phase:"unknown"),.slack:BotViewState(phase:"connected")]) == .warning)
  assert(aggregate([.discord:BotViewState(phase:"stopped"),.slack:BotViewState(phase:"stopped")]) == .stopped)
  assert(aggregate([.discord:BotViewState(phase:"stopping"),.slack:BotViewState(phase:"connected")]) == .progress)
  assert(isStale(lastReply:10,now:16));assert(!isStale(lastReply:10,now:15.9))
  let suite="aside-menu-tests-\(UUID())";let defaults=UserDefaults(suiteName:suite)!;defer{defaults.removePersistentDomain(forName:suite)}
  let settings=MenuSettings(defaults);assert(!settings.autoStartBots && !settings.launchAtLoginRequested && settings.preventIdleSleep)
  settings.autoStartBots=true;assert(MenuSettings(defaults).autoStartBots && !MenuSettings(defaults).launchAtLoginRequested)
  var quit=QuitState();assert(!quit.begin());quit.timedOut();quit.wantsExit=false
  assert(quit.finish() == .stay);assert(!quit.readyToExit);assert(!quit.begin());assert(quit.finish() == .reply)
  let temp=URL(fileURLWithPath:"/tmp").appendingPathComponent("am-"+UUID().uuidString.prefix(8));let fm=FileManager.default
  try fm.createDirectory(at:temp,withIntermediateDirectories:true);defer{try? fm.removeItem(at:temp)}
  let logs=temp.appendingPathComponent("logs")
  appendSafeEvent(platform:.slack,code:"xoxb-secret",stage:"engine",folder:logs)
  appendSafeEvent(platform:.slack,code:"connected",stage:"xapp-secret\n",folder:logs)
  assert(!fm.fileExists(atPath:logs.path))
  appendSafeEvent(platform:.slack,code:"connected",stage:"engine",folder:logs)
  let logged=try String(contentsOf:logs.appendingPathComponent("slack.log"),encoding:.utf8);assert(!logged.contains("xoxb") && !logged.contains("xapp"));assert(logged.contains("connected"))
  let lockDir=temp.appendingPathComponent("app")
  let first=try AppInstanceLock(folder:lockDir)
  do{_ = try AppInstanceLock(folder:lockDir);assertionFailure("second app acquired the lock")}catch{}
  withExtendedLifetime(first){}
  if CommandLine.arguments.count==3 {try await takeoverRegression(node:URL(fileURLWithPath:CommandLine.arguments[1]));try await lifecycle(temp:temp,node:URL(fileURLWithPath:CommandLine.arguments[1]),runtime:CommandLine.arguments[2])}
  print("menubar checks passed")
 }
 @MainActor static func lifecycle(temp:URL,node:URL,runtime:String) async throws {
  let fm=FileManager.default,project=temp.appendingPathComponent("공백 프로젝트"),data=temp.appendingPathComponent("data"),logs=temp.appendingPathComponent("events")
  try fm.createDirectory(at:project.appendingPathComponent("dist/src/slack"),withIntermediateDirectories:true)
  try fm.createDirectory(at:project.appendingPathComponent("dist/scripts"),withIntermediateDirectories:true)
  let config=try JSONSerialization.data(withJSONObject:["dataDir":data.path]);try config.write(to:project.appendingPathComponent("config.local.json"));try Data("{}".utf8).write(to:project.appendingPathComponent("config.slack.local.json"))
  try Data("process.exit(0);".utf8).write(to:project.appendingPathComponent("dist/scripts/prepare-bots.js"))
  let runtimeURL=URL(fileURLWithPath:runtime).absoluteString
  let script="""
  import {startRuntimeControl,readManagedBootstrap} from '\(runtimeURL)';
  import {mkdir,writeFile,unlink} from 'node:fs/promises';import {existsSync} from 'node:fs';import net from 'node:net';
  const originalWrite=net.Socket.prototype.write;net.Socket.prototype.write=function(value,...args){if(existsSync('old-instance')&&typeof value==='string'){try{const parsed=JSON.parse(value);if(parsed.status){parsed.status.instanceId='old-instance';value=JSON.stringify(parsed)+'\\n';}}catch{}}return originalWrite.call(this,value,...args);};
  process.stdout.write('xoxb-'+ 'x'.repeat(2*1024*1024));process.stderr.write('xapp-'+ 'x'.repeat(2*1024*1024));
  const platform=process.argv[1].includes('/slack/')?'slack':'discord';
  const dir='\(data.path)'+(platform==='slack'?'/slack':'');await mkdir(dir,{recursive:true,mode:0o700});
  await writeFile(dir+'/service.lock',String(process.pid),{mode:0o600});
  const boot=await readManagedBootstrap();let c;
  const stop=async()=>{while(existsSync('hold-stop'))await new Promise(r=>setTimeout(r,10));await c.close();await unlink(dir+'/service.lock');process.exit(0);};
  c=await startRuntimeControl({dataDir:dir,platform,ownerToken:boot.token,initialSleep:boot.sleepEnabled,setSleep:async enabled=>enabled,shutdown:stop});
  await c.waitForOwner();c.publish({phase:'connected',stage:'engine',preflightPassed:true,engineStarted:true});
  process.on('SIGTERM',()=>void stop());
  setInterval(()=>{if(existsSync('crash-slack')&&platform==='slack')process.exit(1);},10);
  """
  for file in ["dist/src/main.js","dist/src/slack/main.js"]{try Data(script.utf8).write(to:project.appendingPathComponent(file))}
  let c=BotController(projectURL:project,nodeURL:node,preventSleep:false,logDirectory:logs,discoverServices:{_ in []})
  let first=Task{try await c.startBoth()};await Task.yield()
  do{try await c.startBoth();assertionFailure("concurrent start must fail")}catch{}
  try await first.value;await c.refresh();assert(aggregate(c.bots) == .normal)
  do{_ = try ControlChannel(path:data.appendingPathComponent("control.sock").path,pid:getpid());assertionFailure("wrong peer PID accepted")}catch{}
  let ids=c.bots.values.compactMap{$0.snapshot?.instanceId};assert(ids.count==2)
  await c.setSleep(true);assert(c.bots.values.allSatisfy{$0.snapshot?.sleepActive==true});await c.setSleep(false)
  c.invalidate();assert(c.bots.values.allSatisfy{$0.phase=="unknown"});await c.refresh();assert(aggregate(c.bots) == .normal)
  try fm.removeItem(at:project.appendingPathComponent("config.local.json"));await c.refresh();assert(aggregate(c.bots) == .warning)
  try config.write(to:project.appendingPathComponent("config.local.json"));await c.refresh();assert(aggregate(c.bots) == .normal)
  try Data().write(to:project.appendingPathComponent("hold-stop"));let stop=Task{try await c.stopBoth()};try await Task.sleep(nanoseconds:100000000);assert(c.bots.values.allSatisfy{$0.phase=="stopping"})
  try fm.removeItem(at:project.appendingPathComponent("hold-stop"));try await stop.value;assert(aggregate(c.bots) == .stopped)
  // An old instance response is discarded and owner channel loss stops the children.
  try await c.startBoth();try Data().write(to:project.appendingPathComponent("old-instance"));await c.refresh()
  assert(c.bots.values.allSatisfy{$0.snapshot?.instanceId != "old-instance"})
  for _ in 0..<200{if c.bots.values.allSatisfy({$0.phase=="stopped"}){break};try await Task.sleep(nanoseconds:10000000)}
  assert(c.bots.values.allSatisfy{$0.phase=="stopped"});try fm.removeItem(at:project.appendingPathComponent("old-instance"))
  // Stopping during preparation must prevent late startup, even if stop initially has no child.
  let late=Task{try await c.startBoth()};await Task.yield();try await c.stopBoth();do{try await late.value;assertionFailure("cancelled start succeeded")}catch{}
  assert(c.bots.values.allSatisfy{$0.ownership != "managed" || $0.phase=="stopped"})
  try await c.startBoth();try Data().write(to:project.appendingPathComponent("crash-slack"))
  for _ in 0..<200{if c.bots.values.allSatisfy({$0.phase=="stopped"}){break};try await Task.sleep(nanoseconds:10000000)}
  assert(c.bots.values.allSatisfy{$0.phase=="stopped"});try fm.removeItem(at:project.appendingPathComponent("crash-slack"))
  // A live foreign PID in a service lock must block before preparation or spawn.
  try Data(String(getpid()).utf8).write(to:data.appendingPathComponent("service.lock"))
  do{try await c.startBoth();assertionFailure("foreign lock accepted")}catch{}
  assert(c.bots.values.allSatisfy{$0.ownership != "managed"});try fm.removeItem(at:data.appendingPathComponent("service.lock"))
  // Partial startup: the first child is cleaned when the second cannot expose control.
  try Data("process.exit(1);".utf8).write(to:project.appendingPathComponent("dist/src/slack/main.js"))
  do{try await c.startBoth();assertionFailure("partial startup succeeded")}catch{}
  assert(!fm.fileExists(atPath:data.appendingPathComponent("service.lock").path))
 }

 @MainActor static func trackingRegression() throws {
  // Enter the same run-loop mode AppKit uses while a menu is tracking.
  // This is not a real menu and does not launch the application.
  CFRunLoopAddCommonMode(CFRunLoopGetMain(), CFRunLoopMode(rawValue: RunLoop.Mode.eventTracking.rawValue as CFString))
  final class Counter: @unchecked Sendable {var ticks=0}
  let counter=Counter()
  let timer=makeMenuRefreshTimer(interval:0.01){counter.ticks+=1}
  defer{timer.invalidate()}
  let until=Date().addingTimeInterval(0.15)
  while Date()<until {RunLoop.main.run(mode:.eventTracking,before:until)}
  guard counter.ticks>0 else{throw ManagerError("menu_tracking_did_not_refresh")}
 }
 @MainActor static func takeoverRegression(node:URL) async throws {
  let fm=FileManager.default,root=URL(fileURLWithPath:"/tmp/am-take-"+UUID().uuidString.prefix(8)),project=root.appendingPathComponent("project"),data=root.appendingPathComponent("data")
  try fm.createDirectory(at:project.appendingPathComponent("dist/src/slack"),withIntermediateDirectories:true)
  try fm.createDirectory(at:project.appendingPathComponent("dist/scripts"),withIntermediateDirectories:true)
  try fm.createDirectory(at:project.appendingPathComponent("scripts"),withIntermediateDirectories:true)
  defer{try? fm.removeItem(at:root)}
  try JSONSerialization.data(withJSONObject:["dataDir":data.path]).write(to:project.appendingPathComponent("config.local.json"))
  try Data("{}".utf8).write(to:project.appendingPathComponent("config.slack.local.json"))
  try Data("import{writeFileSync}from'node:fs';writeFileSync('prepared','');process.exit(1);".utf8).write(to:project.appendingPathComponent("dist/scripts/prepare-bots.js"))
  let childScript="""
  import{mkdirSync,writeFileSync}from'node:fs';
  const dir='\(data.path)'+(process.argv[1].includes('/slack/')?'/slack':'');mkdirSync(dir,{recursive:true,mode:0o700});writeFileSync(dir+'/service.lock',String(process.pid));
  setInterval(()=>{},1000);
  """
  for file in ["dist/src/main.js","dist/src/slack/main.js"] {try Data(childScript.utf8).write(to:project.appendingPathComponent(file))}
  let launcher="""
  import{spawn}from'node:child_process';import{writeFileSync}from'node:fs';
  const children=['dist/src/main.js','dist/src/slack/main.js'].map(file=>spawn(process.execPath,[file],{stdio:'ignore'}));let stopping=false;
  process.on('SIGTERM',()=>{if(stopping)return;stopping=true;writeFileSync('signalled','');for(const c of children)c.kill('SIGTERM');});
  """
  try Data(launcher.utf8).write(to:project.appendingPathComponent("scripts/start-bots.mjs"))
  let external=Process();external.executableURL=node;external.arguments=[project.appendingPathComponent("scripts/start-bots.mjs").path];external.currentDirectoryURL=project;external.standardOutput=FileHandle.nullDevice;external.standardError=FileHandle.nullDevice;external.environment=["PATH":"/usr/bin:/bin"]
  try external.run()
  defer{if external.isRunning{external.terminate();external.waitUntilExit()}}
  for _ in 0..<200{if fm.fileExists(atPath:data.appendingPathComponent("slack/service.lock").path){break};try await Task.sleep(nanoseconds:10000000)}
  guard fm.fileExists(atPath:data.appendingPathComponent("slack/service.lock").path) else{throw ManagerError("fixture_start_timeout")}
  actor Gate {
   var calls=0;var release:CheckedContinuation<[String],Never>?
   func discover()async->[String]{calls+=1;if calls>1{return []};return await withCheckedContinuation{release=$0}}
   func opened()->Bool{release != nil}
   func resume(){release?.resume(returning:[]);release=nil}
  }
  let gate=Gate();let c=BotController(projectURL:project,nodeURL:node,preventSleep:false,logDirectory:root.appendingPathComponent("logs"),discoverServices:{_ in await gate.discover()})
  let takeover=Task{do{try await c.takeOver();return "completed"}catch{return (error as? ManagerError)?.code ?? "unknown"}}
  while !(await gate.opened()){await Task.yield()}
  var stopped=false
  let stop=Task{try await c.stopBoth();stopped=true}
  // A correct stop waits for the pending takeover to acknowledge cancellation.
  try await Task.sleep(nanoseconds:150000000)
  let stopReturnedEarly=stopped
  await gate.resume()
  let outcome=await takeover.value;try await stop.value
  let signalled=fm.fileExists(atPath:project.appendingPathComponent("signalled").path)
  let prepared=fm.fileExists(atPath:project.appendingPathComponent("prepared").path)
  guard !stopReturnedEarly,!signalled,!prepared,external.isRunning,outcome=="shutdown_pending" else{
   throw ManagerError("takeover_after_stop:early=\(stopReturnedEarly),signalled=\(signalled),prepared=\(prepared),outcome=\(outcome)")
  }
 }
}
