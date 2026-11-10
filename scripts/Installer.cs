using System;
using System.IO;
using System.IO.Compression;
using System.Diagnostics;
using System.Reflection;
using System.Windows.Forms;
using System.Collections.Generic;

class Installer {
    static string Quote(string text) { if(text.Contains("\"") || text.EndsWith("\\")) throw new Exception("Invalid installer argument."); return "\"" + text + "\""; }
    [STAThread] static int Main(string[] args) {
        string temporary = Path.Combine(Path.GetTempPath(), "PoEAssistantInstall-" + Guid.NewGuid().ToString("N"));
        bool silent = Array.IndexOf(args, "--silent") >= 0;
        try {
            string pob = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "Path of Building Community");
            string destination = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "PoE Assistant");
            bool noShortcut = Array.IndexOf(args, "--no-shortcut") >= 0;
            for(int i=0;i<args.Length;i++) {
                if(args[i] == "--pob" && i+1<args.Length) pob=args[++i];
                else if(args[i] == "--destination" && i+1<args.Length) destination=args[++i];
            }
            if(!silent) {
                Application.EnableVisualStyles();
                using(var dialog = new OpenFileDialog()) {
                    dialog.Title="Select your Path of Building Community executable";
                    dialog.Filter="Path of Building|Path of Building.exe";
                    if(Directory.Exists(pob)) dialog.InitialDirectory=pob;
                    if(dialog.ShowDialog() != DialogResult.OK) return 0;
                    pob=Path.GetDirectoryName(dialog.FileName);
                }
                if(MessageBox.Show("Install PoE Assistant in:\n" + destination + "\n\nPoB: " + pob + "\n\nYour official PoB updater and builds are preserved.", "PoE Assistant Setup", MessageBoxButtons.OKCancel) != DialogResult.OK) return 0;
            }
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
            if(!silent) MessageBox.Show("Installed. Open the PoE Assistant shortcut. Use Update PoE Assistant for independent addon updates.","PoE Assistant");
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
