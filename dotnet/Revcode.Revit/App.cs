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
        panel.AddItem(new PushButtonData("Revcode.Open", "Open\nRevcode", Assembly.GetExecutingAssembly().Location, typeof(OpenCommand).FullName)
        { ToolTip = "Open Revcode chat and C# console for this Revit instance." });
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
