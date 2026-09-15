using System.Reflection;
using Autodesk.Revit.Attributes;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;

namespace Revcode.Revit;

public sealed class App : IExternalApplication
{
    internal static NativeService? Service;
    private static bool smokeAttempted;

    public Result OnStartup(UIControlledApplication application)
    {
        var panel = application.CreateRibbonPanel("Revcode");
        var button = (SplitButton)panel.AddItem(new SplitButtonData("Revcode.Menu", "Revcode"));
        var mark = RibbonImages.Mark();
        void Add<T>(string name, string label, string tooltip, System.Windows.Media.ImageSource image)
        {
            button.AddPushButton(new PushButtonData(name, label, Assembly.GetExecutingAssembly().Location, typeof(T).FullName)
            {
                ToolTip = tooltip, Image = image, LargeImage = image,
                AvailabilityClassName = typeof(ToolbarAvailability).FullName
            });
        }
        Add<OpenCommand>("Revcode.Open", "Revcode", "Open Revcode chat and C# console for this Revit instance. Starts Revcode if stopped.", mark);
        button.AddSeparator();
        Add<RestartCommand>("Revcode.Restart", "Restart Revcode", "Stop the local host, then start Revcode and reopen the browser. Active requests are interrupted.",
            RibbonImages.Action("M 20,10 A 8,8 0 1 0 20,15 M 20,4 L 20,10 L 14,10"));
        Add<StopCommand>("Revcode.Stop", "Stop Revcode", "Stop Revcode for this Revit instance and cancel pending requests.",
            RibbonImages.Action("M 6,6 L 18,6 L 18,18 L 6,18 Z"));
        Add<StatusCommand>("Revcode.Status", "Check status", "Show Revcode's current state for this Revit instance.",
            RibbonImages.Action("M 12,3 A 9,9 0 1 1 12,21 A 9,9 0 1 1 12,3 M 12,11 L 12,17 M 12,7 L 12,7.2"));
        // Always open on the main click, even after choosing Stop or Status.
        button.IsSynchronizedWithCurrentItem = false;
        application.Idling += OnIdling;
        return Result.Succeeded;
    }

    private static void OnIdling(object? sender, Autodesk.Revit.UI.Events.IdlingEventArgs e)
    {
        if (sender is not UIApplication app) return;
        if (!smokeAttempted && Environment.GetEnvironmentVariable("REVCODE_SMOKE_DIR") is { Length: > 0 } smokeDir)
        {
            smokeAttempted = true;
            // Explicit test-only opt-in. Never target or save an existing user document.
            try
            {
                var directory = Path.GetFullPath(smokeDir);
                if (!Path.IsPathFullyQualified(smokeDir) || app.ActiveUIDocument != null)
                    throw new InvalidOperationException("Smoke mode requires an absolute output directory and no active document.");
                Directory.CreateDirectory(directory);
                var projectPath = Path.Combine(directory, "Revcode-Smoke-" + Guid.NewGuid().ToString("N") + ".rvt");
                using (var document = app.Application.NewProjectDocument(Autodesk.Revit.DB.UnitSystem.Imperial))
                {
                    document.SaveAs(projectPath, new SaveAsOptions { OverwriteExistingFile = false });
                    document.Close(false);
                }
                app.OpenAndActivateDocument(projectPath);
                Service ??= new NativeService(app);
                Service.OpenBrowser();
                File.WriteAllText(Path.Combine(directory, "smoke-project.txt"), projectPath);
            }
            catch (Exception ex)
            {
                try { File.WriteAllText(Path.Combine(smokeDir, "smoke-error.txt"), ex.ToString()); } catch { }
            }
        }
        Service?.OnIdling(app);
    }

    public Result OnShutdown(UIControlledApplication application)
    {
        application.Idling -= OnIdling;
        Service?.Dispose();
        Service = null;
        return Result.Succeeded;
    }
}

public sealed class ToolbarAvailability : IExternalCommandAvailability
{
    public bool IsCommandAvailable(UIApplication applicationData, CategorySet selectedCategories) => true;
}

[Transaction(TransactionMode.Manual)]
public sealed class StopCommand : IExternalCommand
{
    public Result Execute(ExternalCommandData commandData, ref string message, ElementSet elements)
    {
        App.Service?.Stop();
        TaskDialog.Show("Revcode", App.Service is null ? "Revcode is stopped." :
            "Revcode is stopping. Pending requests are being cancelled.\n\nUse Check status to see when it has stopped. Click Revcode to start it again.");
        return Result.Succeeded;
    }
}

[Transaction(TransactionMode.Manual)]
public sealed class RestartCommand : IExternalCommand
{
    public Result Execute(ExternalCommandData commandData, ref string message, ElementSet elements)
    {
        try
        {
            App.Service ??= new NativeService(commandData.Application);
            App.Service.Stop(restart: true);
            TaskDialog.Show("Revcode", "Revcode is restarting. Pending requests are being cancelled. The browser will open when Revcode is ready.");
            return Result.Succeeded;
        }
        catch (Exception ex) { message = "Revcode could not restart: " + ex.Message; return Result.Failed; }
    }
}

[Transaction(TransactionMode.Manual)]
public sealed class StatusCommand : IExternalCommand
{
    public Result Execute(ExternalCommandData commandData, ref string message, ElementSet elements)
    {
        TaskDialog.Show("Revcode status", App.Service?.Status ?? "Stopped\n\nClick Revcode to start it for this Revit instance.");
        return Result.Succeeded;
    }
}

[Transaction(TransactionMode.Manual)]
public sealed class OpenCommand : IExternalCommand
{
    public Result Execute(ExternalCommandData commandData, ref string message, ElementSet elements)
    {
        try
        {
            App.Service ??= new NativeService(commandData.Application);
            App.Service.OpenBrowser();
            return Result.Succeeded;
        }
        catch (Exception ex)
        {
            message = "Revcode could not start: " + ex.Message;
            return Result.Failed;
        }
    }
}
