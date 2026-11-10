using System;
using System.IO;
using System.IO.Compression;
using System.Diagnostics;
using System.Reflection;
using System.Windows.Forms;
using System.Collections.Generic;
using System.Text;
using System.Threading.Tasks;
using System.Web.Script.Serialization;

class Installer {
    // Read chunks while the child is running. ReadToEndAsync loses all buffered
    // diagnostics when a detached descendant retains an inherited pipe handle.
    sealed class Capture {
        readonly object gate = new object();
        readonly StringBuilder tail = new StringBuilder();
        bool frozen;
        int written;
        public bool Eof;
        public Task Pump;
        public Capture(StreamReader reader, string file) {
            Pump=Task.Factory.StartNew(delegate {
                try {
                    var bytes=new byte[4096]; var chunk=new char[4096]; int count;
                    var decoder=Encoding.UTF8.GetDecoder();
                    while((count=reader.BaseStream.Read(bytes,0,bytes.Length))>0) {
                        count=decoder.GetChars(bytes,0,count,chunk,0);
                        lock(gate) {
                            if(frozen) return;
                            tail.Append(chunk,0,count);
                            if(tail.Length>131072) tail.Remove(0,tail.Length-131072);
                            if(written<2097152) {
                                int keep=Math.Min(count,2097152-written);
                                Append(file,new string(chunk,0,keep)); written+=keep;
                            }
                        }
                    }
                    lock(gate) Eof=true;
                } catch { /* A retained descendant pipe may be closed at exit. */ }
            },TaskCreationOptions.LongRunning);
        }
        public string Freeze() { lock(gate) { frozen=true; return tail.ToString(); } }
    }
    static void Append(string file, string value) { try { File.AppendAllText(file,value,new UTF8Encoding(false)); } catch { } }
    static Dictionary<string,object> Json(string file) {
        return new JavaScriptSerializer().Deserialize<Dictionary<string,object>>(File.ReadAllText(file,Encoding.UTF8));
    }
    static string Field(Dictionary<string,object> value,string key) { return value.ContainsKey(key) ? Convert.ToString(value[key]) : ""; }
    static bool SamePath(string a,string b) { return String.Equals(PoeAssistantShortcut.NormalizePath(a).TrimEnd('\\'),PoeAssistantShortcut.NormalizePath(b).TrimEnd('\\'),StringComparison.OrdinalIgnoreCase); }
    static string Short(string text,int length) { return text.Length>length ? text.Substring(0,length)+"..." : text; }
    static void ShowFailure(string cause,string details,string file) {
        Application.EnableVisualStyles();
        using(var form=new Form()) {
            form.Text="PoE Assistant — installation failed"; form.ClientSize=new System.Drawing.Size(650,330);
            form.StartPosition=FormStartPosition.CenterScreen; form.MinimizeBox=false; form.MaximizeBox=false;
            var title=new Label { Text="Installation could not be completed",Left=20,Top=18,Width=610,Height=28,Font=new System.Drawing.Font("Segoe UI",12,System.Drawing.FontStyle.Bold) };
            var body=new TextBox { Text=cause,Left=20,Top=58,Width=610,Height=160,Multiline=true,ReadOnly=true,ScrollBars=ScrollBars.Vertical };
            var location=new Label { Text="Diagnostics: "+file,Left=20,Top=230,Width=610,Height=40 };
            var open=new Button { Text="Open log",Left=20,Top=282,Width=110,Height=30 };
            open.Click+=delegate { try { Process.Start("notepad.exe",Quote(file)); } catch(Exception e) { MessageBox.Show(e.Message); } };
            var copy=new Button { Text="Copy details",Left=140,Top=282,Width=120,Height=30 };
            copy.Click+=delegate { try { Clipboard.SetText(details); copy.Text="Copied"; } catch(Exception e) { MessageBox.Show(e.Message); } };
            var close=new Button { Text="Close",Left=530,Top=282,Width=100,Height=30,DialogResult=DialogResult.OK };
            form.Controls.AddRange(new Control[]{title,body,location,open,copy,close}); form.AcceptButton=close; form.CancelButton=close;
            form.ShowDialog();
        }
    }
    static bool SelectPob(ref string pob, ref string shortcut) {
        Application.EnableVisualStyles();
        using(var form = new Form()) {
            string selected=shortcut;
            form.Text="Install PoE Assistant"; form.ClientSize=new System.Drawing.Size(560,280);
            form.FormBorderStyle=FormBorderStyle.FixedDialog; form.MaximizeBox=false; form.MinimizeBox=false; form.StartPosition=FormStartPosition.CenterScreen;
            var title = new Label { Text="Add an AI assistant to your PoB Fork", Left=22, Top=20, Width=520, Height=26, Font=new System.Drawing.Font("Segoe UI",13,System.Drawing.FontStyle.Bold) };
            var info = new Label { Text="Install into your existing PoB. Browse can select the shortcut you use.\nSetup repairs existing shortcuts and verifies the assistant opens.", Left=22, Top=57, Width=520, Height=42 };
            var label = new Label { Text="Path of Building installation", Left=22, Top=110, Width=440, Height=20 };
            var location = new TextBox { Text=pob, Left=22, Top=134, Width=420 };
            var choice = new Label { Text=selected==null ? "Shortcuts: automatically find existing PoB shortcuts." : "Selected shortcut: "+selected, Left=22, Top=168, Width=516, Height=42, AutoEllipsis=true };
            var browse = new Button { Text="Browse...", Left=450, Top=132, Width=88, Height=26 };
            browse.Click += delegate {
                using(var dialog = new OpenFileDialog()) {
                    dialog.Title="Select your PoB shortcut or Path of Building.exe"; dialog.Filter="PoB executable or shortcut|Path of Building.exe;*.lnk";
                    dialog.DereferenceLinks=false;
                    if(Directory.Exists(location.Text)) dialog.InitialDirectory=location.Text;
                    if(dialog.ShowDialog(form)==DialogResult.OK) {
                        try {
                            string target=dialog.FileName,newSelection=null;
                            if(String.Equals(Path.GetExtension(target),".lnk",StringComparison.OrdinalIgnoreCase)) {
                                newSelection=PoeAssistantShortcut.NormalizePath(target);
                                using(var link=PoeAssistantShortcut.Open(target)) target=link.TargetPath;
                            }
                            if(!String.Equals(Path.GetFileName(target),"Path of Building.exe",StringComparison.OrdinalIgnoreCase) || !File.Exists(target)) throw new Exception("Select a shortcut that opens Path of Building.exe, or that executable itself.");
                            location.Text=Path.GetDirectoryName(target); selected=newSelection;
                            choice.Text=selected==null ? "Shortcuts: automatically find existing PoB shortcuts." : "Selected shortcut: "+selected;
                        } catch(Exception error) { MessageBox.Show(form,error.Message,"Select PoB"); }
                    }
                }
            };
            var install = new Button { Text="Install", Left=344, Top=228, Width=94, Height=30 };
            install.Click += delegate {
                if(!File.Exists(Path.Combine(location.Text,"Path of Building.exe"))) { MessageBox.Show(form,"Select the folder containing Path of Building.exe.","Find PoB Fork"); return; }
                form.DialogResult=DialogResult.OK;
            };
            var cancel = new Button { Text="Cancel", Left=448, Top=228, Width=90, Height=30, DialogResult=DialogResult.Cancel };
            form.Controls.AddRange(new Control[]{title,info,label,location,choice,browse,install,cancel}); form.AcceptButton=install; form.CancelButton=cancel;
            if(form.ShowDialog()!=DialogResult.OK) return false;
            pob=location.Text; shortcut=selected; return true;
        }
    }
    static string Quote(string text) { if(text.Contains("\"") || text.EndsWith("\\")) throw new Exception("Invalid installer argument."); return "\"" + text + "\""; }
    [STAThread] static int Main(string[] args) {
        string invocation=Guid.NewGuid().ToString("N");
        string temporary = Path.Combine(Path.GetTempPath(), "PoEAssistantInstall-" + invocation);
        string diagnostics=null,log=null,version="unknown",phase="Preparing setup",pob=null,destination=null,shortcut=null,verifiedShortcut=null;
        string processDetails="";
        bool silent = Array.IndexOf(args, "--silent") >= 0;
        try {
            pob = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "Path of Building Community");
            string diagnosticRoot=Path.GetTempPath();
            bool noShortcut = Array.IndexOf(args, "--no-shortcut") >= 0;
            for(int i=0;i<args.Length;i++) {
                if(args[i] == "--pob" && i+1<args.Length) pob=args[++i];
                else if(args[i] == "--destination" && i+1<args.Length) destination=args[++i];
                else if(args[i] == "--diagnostics" && i+1<args.Length) diagnosticRoot=args[++i];
                else if(args[i] == "--shortcut" && i+1<args.Length) shortcut=args[++i];
            }
            if(noShortcut && shortcut!=null) throw new Exception("Use either --shortcut or --no-shortcut, not both.");
            if(!silent && !SelectPob(ref pob,ref shortcut)) return 0;
            diagnostics=Path.Combine(Path.GetFullPath(diagnosticRoot),"PoEAssistant-setup-"+invocation);
            Directory.CreateDirectory(diagnostics); log=Path.Combine(diagnostics,"setup.log");
            pob=Path.GetFullPath(pob).TrimEnd('\\');
            if(destination==null) destination=Path.Combine(pob,"PoEAssistant");
            destination=Path.GetFullPath(destination).TrimEnd('\\');
            if(shortcut!=null) shortcut=PoeAssistantShortcut.NormalizePath(shortcut);
            Append(log,"Invocation: "+invocation+"\r\nPoB: "+pob+"\r\nDestination: "+destination+"\r\nWindows: "+Environment.OSVersion+"\r\n64-bit OS: "+Environment.Is64BitOperatingSystem+"\r\nStarted UTC: "+DateTime.UtcNow.ToString("o")+"\r\n");
            if(shortcut!=null) Append(log,"Selected shortcut: "+shortcut+"\r\n");
            if(!File.Exists(Path.Combine(pob,"Path of Building.exe"))) throw new Exception("Path of Building Community executable was not found.");
            phase="Extracting package";
            Directory.CreateDirectory(temporary);
            string prefix=Path.GetFullPath(temporary)+Path.DirectorySeparatorChar;
            var paths=new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            using(var resource=Assembly.GetExecutingAssembly().GetManifestResourceStream("Payload.zip"))
            using(var archive=new ZipArchive(resource,ZipArchiveMode.Read)) {
                long total=0;
                foreach(var entry in archive.Entries) {
                    string target=Path.GetFullPath(Path.Combine(temporary,entry.FullName));
                    total+=entry.Length;
                    if(!target.StartsWith(prefix,StringComparison.OrdinalIgnoreCase) || entry.FullName.Contains(":") || !paths.Add(target) || total>1000000000) throw new Exception("Invalid installer archive.");
                    if(String.IsNullOrEmpty(entry.Name)) { Directory.CreateDirectory(target); continue; }
                    Directory.CreateDirectory(Path.GetDirectoryName(target));
                    entry.ExtractToFile(target,false);
                }
            }
            version=Field(Json(Path.Combine(temporary,"package.json")),"version");
            Append(log,"Version: "+version+"\r\n"); phase="Starting Windows installer script";
            string powershell=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System),"WindowsPowerShell","v1.0","powershell.exe");
            var start=new ProcessStartInfo(powershell, "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File " + Quote(Path.Combine(temporary,"scripts","setup-entry.ps1")) + " -Source " + Quote(temporary) + " -Pob " + Quote(pob) + " -Destination " + Quote(destination) + " -Diagnostics " + Quote(diagnostics) + " -Invocation " + Quote(invocation) + (noShortcut ? " -NoShortcut" : "") + (shortcut==null ? "" : " -Shortcut "+Quote(shortcut)));
            start.UseShellExecute=false; start.CreateNoWindow=true; start.RedirectStandardOutput=true; start.RedirectStandardError=true;
            start.StandardOutputEncoding=Encoding.UTF8; start.StandardErrorEncoding=Encoding.UTF8;
            using(var process=Process.Start(start)) {
                var stderr=new Capture(process.StandardError,Path.Combine(diagnostics,"stderr.log"));
                var stdout=new Capture(process.StandardOutput,Path.Combine(diagnostics,"stdout.log"));
                process.WaitForExit();
                Task.WaitAll(new Task[]{stderr.Pump,stdout.Pump},1000);
                string error=stderr.Freeze(),output=stdout.Freeze();
                processDetails="PowerShell exit: "+process.ExitCode+" (0x"+process.ExitCode.ToString("X8")+")\r\nStdout EOF: "+stdout.Eof+"; stderr EOF: "+stderr.Eof;
                Append(log,processDetails+"\r\n\r\nSTDOUT\r\n"+output+"\r\nSTDERR\r\n"+error+"\r\n");
                string phaseFile=Path.Combine(diagnostics,"phase.txt");
                if(File.Exists(phaseFile)) phase=File.ReadAllText(phaseFile,Encoding.UTF8);
                string failureFile=Path.Combine(diagnostics,"failure.json");
                if(File.Exists(failureFile)) {
                    var failure=Json(failureFile); phase=Field(failure,"phase");
                    throw new Exception(Field(failure,"error"));
                }
                if(process.ExitCode!=0) throw new Exception(error.Length>0 ? error : output.Length>0 ? output : "Windows stopped the installer before it returned a result. "+processDetails);
                phase="Confirming verified installation receipt";
                string receiptFile=Path.Combine(diagnostics,"success.json");
                if(!File.Exists(receiptFile)) throw new Exception("The installer exited without confirming activation. No verified installation receipt was returned.");
                var receipt=Json(receiptFile);
                if(Field(receipt,"invocation")!=invocation || Field(receipt,"version")!=version || Field(receipt,"status")!="success" || !SamePath(Field(receipt,"pob"),pob) || !SamePath(Field(receipt,"destination"),destination) || String.IsNullOrEmpty(Field(receipt,"nonce")) || String.IsNullOrEmpty(Field(receipt,"release"))) throw new Exception("The installation receipt does not match this setup invocation.");
                verifiedShortcut=Field(receipt,"verifiedShortcut");
                if(!noShortcut && String.IsNullOrEmpty(verifiedShortcut)) throw new Exception("Setup did not identify a verified PoB shortcut.");
                if(shortcut!=null && !SamePath(shortcut,verifiedShortcut)) throw new Exception("Setup did not verify the selected PoB shortcut.");
            }
            if(!silent) MessageBox.Show("Installed and verified in your PoB Fork.\n\nSetup confirmed the assistant rendered and connected.\n"+(String.IsNullOrEmpty(verifiedShortcut) ? "" : "Open this PoB shortcut:\n"+verifiedShortcut+"\n\n")+"Maximize PoB to see the full chat.","PoE Assistant");
            return 0;
        } catch(Exception error) {
            if(log==null) log=Path.Combine(Path.GetTempPath(),"PoEAssistant-setup-error-"+invocation+".txt");
            string cause="Step: "+phase+"\r\n\r\n"+Short(error.Message,2500);
            if(diagnostics!=null && File.Exists(Path.Combine(diagnostics,"cleanup-errors.log"))) cause+="\r\n\r\nAutomatic cleanup or recovery also reported an error. Open the log for both causes.";
            string details="PoE Assistant "+version+"\r\nInvocation: "+invocation+"\r\nPoB: "+pob+"\r\n"+cause+"\r\n"+processDetails+"\r\nLog: "+log;
            Append(log,"\r\nSETUP FAILED\r\n"+details+"\r\n"+error+"\r\n");
            try { Console.Error.WriteLine(details); } catch { }
            if(!silent) ShowFailure(cause,details,log);
            return 1;
        } finally {
            if(temporary.StartsWith(Path.GetTempPath(),StringComparison.OrdinalIgnoreCase) && Directory.Exists(temporary)) try { Directory.Delete(temporary,true); } catch { }
        }
    }
}
