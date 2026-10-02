import Foundation
import Darwin

struct ProcessIdentity: Equatable {
 let pid:Int32
 let parentPID:Int32
 let uid:UInt32
 let startedAtMicros:UInt64
 let executable:String
 let arguments:[String]
 let workingDirectory:String
}
struct ManagerError: Error { let code:String; init(_ code:String){self.code=code} }
func canonical(_ path:String)->String {URL(fileURLWithPath:path).resolvingSymlinksInPath().standardizedFileURL.path}
func sameProcess(_ a:ProcessIdentity,_ b:ProcessIdentity)->Bool {a==b}
func inspectProcess(_ pid:Int32)throws -> ProcessIdentity? {
 guard pid>0 else {throw ManagerError("invalid_service_lock")}
 var info=proc_bsdinfo()
 let n=proc_pidinfo(pid,PROC_PIDTBSDINFO,0,&info,Int32(MemoryLayout.size(ofValue:info)))
 if n==0 {if errno==ESRCH||errno==ENOENT{return nil};throw ManagerError("identity_unknown")}
 guard n==MemoryLayout.size(ofValue:info) else {throw ManagerError("identity_unknown")}
 var path=[CChar](repeating:0,count:4*Int(MAXPATHLEN))
 guard proc_pidpath(pid,&path,UInt32(path.count))>0 else {throw ManagerError("identity_unknown")}
 var vnode=proc_vnodepathinfo()
 guard proc_pidinfo(pid,PROC_PIDVNODEPATHINFO,0,&vnode,Int32(MemoryLayout.size(ofValue:vnode)))==MemoryLayout.size(ofValue:vnode) else {throw ManagerError("identity_unknown")}
 let cwd=withUnsafePointer(to:&vnode.pvi_cdir.vip_path){p in p.withMemoryRebound(to:CChar.self,capacity:1024){String(cString:$0)}}
 var mib:[Int32]=[CTL_KERN,KERN_PROCARGS2,pid];var size=0
 guard sysctl(&mib,UInt32(mib.count),nil,&size,nil,0)==0,size>4,size<=1024*1024 else {throw ManagerError("identity_unknown")}
 var bytes=[UInt8](repeating:0,count:size)
 guard sysctl(&mib,UInt32(mib.count),&bytes,&size,nil,0)==0 else {throw ManagerError("identity_unknown")}
 let argc=bytes.withUnsafeBytes{$0.loadUnaligned(as:Int32.self)}
 guard argc>0,argc<65536 else {throw ManagerError("identity_unknown")}
 var offset=4
 while offset<size&&bytes[offset] != 0 {offset+=1}
 while offset<size&&bytes[offset]==0 {offset+=1}
 var argv=[String]()
 for _ in 0..<argc {
  let start=offset;while offset<size&&bytes[offset] != 0{offset+=1}
  guard offset<size,let arg=String(bytes:bytes[start..<offset],encoding:.utf8) else {throw ManagerError("identity_unknown")}
  argv.append(arg);offset+=1
 }
 return ProcessIdentity(pid:pid,parentPID:Int32(info.pbi_ppid),uid:info.pbi_uid,startedAtMicros:UInt64(info.pbi_start_tvsec)*1000000+UInt64(info.pbi_start_tvusec),executable:canonical(String(cString:path)),arguments:argv,workingDirectory:canonical(cwd))
}
func findConflictingServices(project:URL)throws -> [String] {
 let fm=FileManager.default,root=canonical(project.path)
 var found=[String]()
 let directories=[fm.homeDirectoryForCurrentUser.appendingPathComponent("Library/LaunchAgents"),URL(fileURLWithPath:"/Library/LaunchAgents"),URL(fileURLWithPath:"/Library/LaunchDaemons")]
 for folder in directories {
  if !fm.fileExists(atPath:folder.path){continue}
  let files=try fm.contentsOfDirectory(at:folder,includingPropertiesForKeys:nil)
  for file in files where file.pathExtension=="plist" {
   let data=try Data(contentsOf:file)
   guard let plist=(try PropertyListSerialization.propertyList(from:data,format:nil)) as? [String:Any] else {throw ManagerError("identity_unknown")}
   let args=plist["ProgramArguments"] as? [String] ?? []
   let label=plist["Label"] as? String ?? file.lastPathComponent
   if label=="local.aside-discord-search"||label=="local.aside-slack"||(plist["WorkingDirectory"] as? String).map(canonical)==root||args.contains(where:{$0.hasPrefix(root+"/")&&( $0.hasSuffix("/main.js")||$0.hasSuffix("/start-bots.mjs"))}){found.append(file.lastPathComponent)}
  }
 }
 for label in ["local.aside-discord-search","local.aside-slack"] {
  let p=Process();p.executableURL=URL(fileURLWithPath:"/bin/launchctl");p.arguments=["print","gui/\(getuid())/\(label)"];p.standardOutput=FileHandle.nullDevice;p.standardError=FileHandle.nullDevice
  try p.run();p.waitUntilExit();if p.terminationStatus==0{found.append(label)}
 }
 return Array(Set(found)).sorted()
}
