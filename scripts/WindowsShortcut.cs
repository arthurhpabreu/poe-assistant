using System;
using System.IO;
using System.Text;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;

// WScript.Shell rejects paths outside the active ANSI code page. Use the
// documented Unicode Shell Link/IPersistFile interfaces instead.
[ComImport, Guid("000214F9-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IPoeShellLinkW {
    void GetPath([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder path, int count, IntPtr data, uint flags);
    void GetIDList(out IntPtr value); void SetIDList(IntPtr value);
    void GetDescription([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder value, int count);
    void SetDescription([MarshalAs(UnmanagedType.LPWStr)] string value);
    void GetWorkingDirectory([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder value, int count);
    void SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string value);
    void GetArguments([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder value, int count);
    void SetArguments([MarshalAs(UnmanagedType.LPWStr)] string value);
    void GetHotkey(out short value); void SetHotkey(short value);
    void GetShowCmd(out int value); void SetShowCmd(int value);
    void GetIconLocation([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder value, int count, out int index);
    void SetIconLocation([MarshalAs(UnmanagedType.LPWStr)] string value, int index);
    void SetRelativePath([MarshalAs(UnmanagedType.LPWStr)] string value, uint reserved);
    void Resolve(IntPtr window, uint flags);
    void SetPath([MarshalAs(UnmanagedType.LPWStr)] string value);
}
public sealed class PoeAssistantShortcut : IDisposable {
    readonly string file;
    object instance;
    IPoeShellLinkW link;
    PoeAssistantShortcut(string file) {
        this.file=Path.GetFullPath(file);
        instance=Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("00021401-0000-0000-C000-000000000046")));
        link=(IPoeShellLinkW)instance;
        if(File.Exists(this.file)) ((IPersistFile)instance).Load(this.file,0);
    }
    public static PoeAssistantShortcut Open(string file) { return new PoeAssistantShortcut(file); }
    public string TargetPath { get { var value=new StringBuilder(32768); link.GetPath(value,value.Capacity,IntPtr.Zero,4); return value.ToString(); } set { link.SetPath(value); } }
    public string Arguments { get { var value=new StringBuilder(32768); link.GetArguments(value,value.Capacity); return value.ToString(); } set { link.SetArguments(value); } }
    public string WorkingDirectory { get { var value=new StringBuilder(32768); link.GetWorkingDirectory(value,value.Capacity); return value.ToString(); } set { link.SetWorkingDirectory(value); } }
    public string Description { get { var value=new StringBuilder(32768); link.GetDescription(value,value.Capacity); return value.ToString(); } set { link.SetDescription(value); } }
    public string IconLocation { set { int comma=value.LastIndexOf(','); int index=0; string icon=value; if(comma>=0 && Int32.TryParse(value.Substring(comma+1),out index)) icon=value.Substring(0,comma); link.SetIconLocation(icon,index); } }
    public void Save() { ((IPersistFile)instance).Save(file,true); }
    public void Dispose() { if(instance!=null) { Marshal.FinalReleaseComObject(instance); instance=null; link=null; } }
}
