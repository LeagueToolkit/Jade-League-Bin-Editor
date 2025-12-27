using System;
using System.IO;
using System.IO.Pipes;
using System.Threading;
using System.Threading.Tasks;
using System.Linq;
using System.Windows;
using Jade.Windows;
using Jade.Services;

namespace Jade;

public partial class App : Application
{
    private const string MutexName = "Global\\JadeBinEditor_SingleInstance_Mutex";
    private const string PipeName = "JadeBinEditor_SingleInstance_Pipe";
    
    private static Mutex? _mutex;
    private CancellationTokenSource? _pipeServerCts;
    
    public static string? StartupFilePath { get; private set; }
    
    protected override void OnStartup(StartupEventArgs e)
    {
        string? filePath = e.Args.Length > 0 ? e.Args[0] : null;
        
        // Try to create mutex - if we can't, another instance is running
        _mutex = new Mutex(true, MutexName, out bool isNewInstance);
        
        if (!isNewInstance)
        {
            // Another instance is running - send file path to it and exit
            if (!string.IsNullOrEmpty(filePath))
            {
                SendFilePathToExistingInstance(filePath);
            }
            else
            {
                // Just bring existing window to front (send empty message)
                SendFilePathToExistingInstance("__ACTIVATE__");
            }
            
            Shutdown();
            return;
        }
        
        // We are the first instance
        base.OnStartup(e);
        
        if (!string.IsNullOrEmpty(filePath))
        {
            StartupFilePath = filePath;
            Services.Logger.Info($"Application started with file argument: {StartupFilePath}");
        }
        
        // Start listening for messages from other instances
        StartPipeServer();

        // Create the main window manually
        var mainWindow = new MainWindow();
        this.MainWindow = mainWindow;

        // Load rounded edges preference
        LoadRoundedEdgesPreference();
        
        // *** LOAD THEME ON STARTUP ***
        ThemeManager.LoadSavedTheme();

        // Check if we should start hidden
        bool startMinimized = e.Args.Contains("--minimized");
        bool hasFile = !string.IsNullOrEmpty(StartupFilePath);

        if (startMinimized && !hasFile)
        {
            Services.Logger.Info("MainWindow initialized hidden (minimized to tray)");
            // Do NOT call Show() yet
        }
        else
        {
            mainWindow.Show();
            if (hasFile)
            {
                mainWindow.Activate();
            }
        }
    }
    
    protected override void OnExit(ExitEventArgs e)
    {
        _pipeServerCts?.Cancel();
        _mutex?.ReleaseMutex();
        _mutex?.Dispose();
        base.OnExit(e);
    }
    
    private void SendFilePathToExistingInstance(string filePath)
    {
        try
        {
            using var client = new NamedPipeClientStream(".", PipeName, PipeDirection.Out);
            client.Connect(1000); // 1 second timeout
            
            using var writer = new StreamWriter(client);
            writer.WriteLine(filePath);
            writer.Flush();
            
            Services.Logger.Info($"Sent file path to existing instance: {filePath}");
        }
        catch (Exception ex)
        {
            Services.Logger.Error("Failed to send file path to existing instance", ex);
        }
    }
    
    private void StartPipeServer()
    {
        _pipeServerCts = new CancellationTokenSource();
        var token = _pipeServerCts.Token;
        
        Task.Run(async () =>
        {
            while (!token.IsCancellationRequested)
            {
                try
                {
                    using var server = new NamedPipeServerStream(PipeName, PipeDirection.In);
                    await server.WaitForConnectionAsync(token);
                    
                    using var reader = new StreamReader(server);
                    var message = await reader.ReadLineAsync();
                    
                    if (!string.IsNullOrEmpty(message))
                    {
                        // Dispatch to UI thread
                        await Dispatcher.InvokeAsync(async () =>
                        {
                            // Always use TrayService to ensure window is visible and active
                            TrayService.ShowMainWindow();
                            
                            var mainWindow = MainWindow as MainWindow;
                            if (mainWindow != null)
                            {
                                // Open file if it's not just an activation request
                                if (message != "__ACTIVATE__" && File.Exists(message))
                                {
                                    await mainWindow.OpenFileFromPathAsync(message);
                                }
                            }
                        });
                    }
                }
                catch (OperationCanceledException)
                {
                    break;
                }
                catch (Exception ex)
                {
                    Services.Logger.Error("Pipe server error", ex);
                }
            }
        }, token);
        
        Services.Logger.Info("Pipe server started for single-instance support");
    }

    private void LoadRoundedEdgesPreference()
    {
        try
        {
            string appData = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
            string prefFolder = Path.Combine(appData, "RitoShark", "Jade");
            string prefPath = Path.Combine(prefFolder, "preferences.txt");
            
            if (File.Exists(prefPath))
            {
                var lines = File.ReadAllLines(prefPath);
                var roundedLine = lines.FirstOrDefault(l => l.StartsWith("RoundedEdges="));
                if (roundedLine != null && bool.TryParse(roundedLine.Split('=')[1], out bool rounded))
                {
                    Resources["GlobalCornerRadius"] = new CornerRadius(rounded ? 3 : 0);
                }
            }
        }
        catch (Exception ex)
        {
            Services.Logger.Error("Failed to load rounded edges preference", ex);
        }
    }
}
