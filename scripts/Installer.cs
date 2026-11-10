using System;
using System.IO;
using System.IO.Compression;
using System.Diagnostics;
using System.Reflection;
using System.Windows.Forms;
using System.Collections.Generic;

class Installer {
    static bool SelectPob(ref string pob) {
        Application.EnableVisualStyles();
        using(var form = new Form()) {
            form.Text="Install PoE Assistant"; form.ClientSize=new System.Drawing.Size(560,235);
            form.FormBorderStyle=FormBorderStyle.FixedDialog; form.MaximizeBox=false; form.MinimizeBox=false; form.StartPosition=FormStartPosition.CenterScreen;
            var title = new Label { Text="Add an AI assistant to your PoB Fork", Left=22, Top=20, Width=520, Height=26, Font=new System.Drawing.Font("Segoe UI",13,System.Drawing.FontStyle.Bold) };
            var info = new Label { Text="Install once. Keep opening Path of Building with your usual shortcut.\nNo extra shortcuts. Your builds and PoB updater are preserved.", Left=22, Top=57, Width=520, Height=42 };
            var label = new Label { Text="Path of Building installation", Left=22, Top=110, Width=440, Height=20 };
            var location = new TextBox { Text=pob, Left=22, Top=134, Width=420 };
            var browse = new Button { Text="Browse...", Left=450, Top=132, Width=88, Height=26 };
            browse.Click += delegate {
                using(var dialog = new OpenFileDialog()) {
                    dialog.Title="Find Path of Building.exe"; dialog.Filter="Path of Building|Path of Building.exe";
                    if(Directory.Exists(location.Text)) dialog.InitialDirectory=location.Text;
                    if(dialog.ShowDialog(form)==DialogResult.OK) location.Text=Path.GetDirectoryName(dialog.FileName);
                }
            };
            var install = new Button { Text="Install", Left=344, Top=183, Width=94, Height=30 };
            install.Click += delegate {
                if(!File.Exists(Path.Combine(location.Text,"Path of Building.exe"))) { MessageBox.Show(form,"Select the folder containing Path of Building.exe.","Find PoB Fork"); return; }
                form.DialogResult=DialogResult.OK;
            };
            var cancel = new Button { Text="Cancel", Left=448, Top=183, Width=90, Height=30, DialogResult=DialogResult.Cancel };
            form.Controls.AddRange(new Control[]{title,info,label,location,browse,install,cancel}); form.AcceptButton=install; form.CancelButton=cancel;
            if(form.ShowDialog()!=DialogResult.OK) return false;
            pob=location.Text; return true;
        }
    }
    static string Quote(string text) { if(text.Contains("\"") || text.EndsWith("\\")) throw new Exception("Invalid installer argument."); return "\"" + text + "\""; }
    [STAThread] static int Main(string[] args) {
        string temporary = Path.Combine(Path.GetTempPath(), "PoEAssistantInstall-" + Guid.NewGuid().ToString("N"));
        bool silent = Array.IndexOf(args, "--silent") >= 0;
        try {
            string pob = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "Path of Building Community");
            string destination = null;
            bool noShortcut = Array.IndexOf(args, "--no-shortcut") >= 0;
            for(int i=0;i<args.Length;i++) {
                if(args[i] == "--pob" && i+1<args.Length) pob=args[++i];
                else if(args[i] == "--destination" && i+1<args.Length) destination=args[++i];
            }
            if(!silent && !SelectPob(ref pob)) return 0;
            if(destination==null) destination=Path.Combine(pob,"PoEAssistant");
            if(!File.Exists(Path.Combine(pob,"Path of Building.exe"))) throw new Exception("Path of Building Community executable was not found.");
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
            var start=new ProcessStartInfo("powershell.exe", "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File " + Quote(Path.Combine(temporary,"scripts","deploy.ps1")) + " -Source " + Quote(temporary) + " -Pob " + Quote(pob) + " -Destination " + Quote(destination) + (noShortcut ? " -NoShortcut" : ""));
            start.UseShellExecute=false; start.CreateNoWindow=true; start.RedirectStandardOutput=true; start.RedirectStandardError=true;
            using(var process=Process.Start(start)) {
                string error=null;
                var readError=process.StandardError.ReadToEndAsync();
                var readOutput=process.StandardOutput.ReadToEndAsync();
                process.WaitForExit();
                // A detached backend may inherit a pipe handle. Do not wait for
                // EOF from descendants after the installer process has exited.
                if(process.ExitCode!=0) {
                    error=readError.Wait(1000) ? readError.Result : "";
                    string output=readOutput.Wait(1000) ? readOutput.Result : "";
                    throw new Exception(error.Length>0 ? error : output.Length>0 ? output : "Installation failed. No successful activation was confirmed.");
                }
            }
            if(!silent) MessageBox.Show("Installed and verified in your PoB Fork.\n\nSetup opened an isolated PoB check and confirmed the assistant rendered.\nOpen your usual Path of Building shortcut. Maximize PoB to see the full chat.","PoE Assistant");
            return 0;
        } catch(Exception error) {
            string log=Path.Combine(Path.GetTempPath(),"PoEAssistant-setup-error-"+Guid.NewGuid().ToString("N")+".txt");
            File.WriteAllText(log,error.Message);
            if(!silent) MessageBox.Show(error.Message+"\n\nLog: "+log,"PoE Assistant Setup",MessageBoxButtons.OK,MessageBoxIcon.Error);
            return 1;
        } finally {
            if(temporary.StartsWith(Path.GetTempPath(),StringComparison.OrdinalIgnoreCase) && Directory.Exists(temporary)) try { Directory.Delete(temporary,true); } catch { }
        }
    }
}
