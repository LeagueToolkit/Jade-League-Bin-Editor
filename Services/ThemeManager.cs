using System;
using System.IO;
using System.Linq;
using System.Windows;
using System.Windows.Media;

namespace Jade.Services;

public static class ThemeManager
{
    public static void ApplyTheme(string themeName)
    {
        try
        {
            var app = Application.Current;
            if (app == null) return;

            // Remove existing theme dictionaries
            var existingTheme = app.Resources.MergedDictionaries
                .FirstOrDefault(d => d.Source?.OriginalString?.Contains("/Themes/") == true);
            
            if (existingTheme != null)
            {
                app.Resources.MergedDictionaries.Remove(existingTheme);
            }

            // Handle custom theme separately
            if (themeName == "Custom")
            {
                ApplyCustomTheme();
                return;
            }

            // Clear any local overrides from a previous custom theme
            ClearCustomThemeOverrides(app);

            // Load the new theme dictionary
            var themeUri = new Uri($"/Themes/{themeName}Theme.xaml", UriKind.Relative);
            var themeDict = new ResourceDictionary { Source = themeUri };
            
            app.Resources.MergedDictionaries.Add(themeDict);
            
            Logger.Info($"Applied theme: {themeName}");
        }
        catch (Exception ex)
        {
            Logger.Error($"Failed to apply theme: {themeName}", ex);
            // Fallback to default theme
            ApplyDefaultTheme();
        }
    }

    private static void ApplyCustomTheme()
    {
        try
        {
            var app = Application.Current;
            if (app == null) return;

            // Read custom colors from preferences
            var bgHex = ThemeHelper.ReadPreference("Custom_Bg", "#0F1928");
            var editorBgHex = ThemeHelper.ReadPreference("Custom_EditorBg", "#141E2D");
            var titleBarHex = ThemeHelper.ReadPreference("Custom_TitleBar", "#0F1928");
            var statusBarHex = ThemeHelper.ReadPreference("Custom_StatusBar", "#005A9E");
            var textHex = ThemeHelper.ReadPreference("Custom_Text", "#D4D4D4");
            var tabBgHex = ThemeHelper.ReadPreference("Custom_TabBg", "#1E1E1E");
            var selectedTabHex = ThemeHelper.ReadPreference("Custom_SelectedTab", "#007ACC");

            // Apply colors to application resources
            app.Resources["WindowBackgroundBrush"] = ThemeHelper.GetBrushFromHex(bgHex);
            app.Resources["EditorBackgroundBrush"] = ThemeHelper.GetBrushFromHex(editorBgHex);
            app.Resources["TitleBarBackgroundBrush"] = ThemeHelper.GetBrushFromHex(titleBarHex);
            app.Resources["StatusBarBackgroundBrush"] = ThemeHelper.GetBrushFromHex(statusBarHex);
            app.Resources["PrimaryTextBrush"] = ThemeHelper.GetBrushFromHex(textHex);
            app.Resources["TabBackgroundBrush"] = ThemeHelper.GetBrushFromHex(tabBgHex);
            app.Resources["SelectedTabBackgroundBrush"] = ThemeHelper.GetBrushFromHex(selectedTabHex);
            
            // Generate derived colors
            var textBrush = ThemeHelper.GetBrushFromHex(textHex);
            app.Resources["MutedTextBrush"] = ThemeHelper.GetBrighterBrush(textBrush, 0.7);
            app.Resources["CardBackgroundBrush"] = ThemeHelper.GetBrushFromHex(editorBgHex);
            app.Resources["AccentBrush"] = ThemeHelper.GetBrushFromHex(statusBarHex);
            
            Logger.Info("Applied custom theme");
        }
        catch (Exception ex)
        {
            Logger.Error("Failed to apply custom theme", ex);
            ApplyDefaultTheme();
        }
    }

    private static void ApplyDefaultTheme()
    {
        try
        {
            var app = Application.Current;
            if (app == null) return;

            // Clear any local overrides
            ClearCustomThemeOverrides(app);

            // Load the new theme dictionary
            var themeUri = new Uri("/Themes/DefaultTheme.xaml", UriKind.Relative);
            var themeDict = new ResourceDictionary { Source = themeUri };
            
            // Remove existing theme dictionaries
            var existingTheme = app.Resources.MergedDictionaries
                .FirstOrDefault(d => d.Source?.OriginalString?.Contains("/Themes/") == true);
            
            if (existingTheme != null)
            {
                app.Resources.MergedDictionaries.Remove(existingTheme);
            }

            app.Resources.MergedDictionaries.Add(themeDict);
            Logger.Info("Applied fallback default theme");
        }
        catch (Exception ex)
        {
            Logger.Error("Failed to apply fallback default theme", ex);
        }
    }

    private static void ClearCustomThemeOverrides(Application app)
    {
        var keys = new[]
        {
            "WindowBackgroundBrush", "EditorBackgroundBrush", "TitleBarBackgroundBrush",
            "StatusBarBackgroundBrush", "PrimaryTextBrush", "TabBackgroundBrush",
            "SelectedTabBackgroundBrush", "MutedTextBrush", "CardBackgroundBrush", "AccentBrush"
        };
        
        foreach (var key in keys)
        {
            if (app.Resources.Contains(key))
            {
                app.Resources.Remove(key);
            }
        }
    }

    public static string GetCurrentTheme()
    {
        return ThemeHelper.ReadPreference("Theme", "Default");
    }

    public static void LoadSavedTheme()
    {
        var theme = GetCurrentTheme();
        ApplyTheme(theme);
    }

    // Get theme colors for preview purposes
    public static ThemeColors GetThemeColors(string themeName)
    {
        return themeName switch
        {
            "Default" => new ThemeColors(
                "#1E1E1E", "#1E1E1E", "#252526", "#505050", "#D4D4D4", "#252526", "#3E3E42"),
            "DarkBlue" => new ThemeColors(
                "#0F1928", "#141E2D", "#19232E", "#005A9E", "#DCE6F0", "#19232E", "#2D415A"),
            "DarkRed" => new ThemeColors(
                "#280F14", "#2D1419", "#32191E", "#9E0028", "#F0DDE1", "#32191E", "#5A2D37"),
            "LightPink" => new ThemeColors(
                "#C896B4", "#D2A5BE", "#B482A0", "#C71585", "#000000", "#B482A0", "#E696BE"),
            "PastelBlue" => new ThemeColors(
                "#E6F5FF", "#D2F0FF", "#FFF0FA", "#50C8FF", "#000000", "#EBE1FF", "#A0E6FF"),
            "ForestGreen" => new ThemeColors(
                "#142319", "#192D1E", "#1E3223", "#228B22", "#C8E6D2", "#1E3223", "#32553C"),
            "AMOLED" => new ThemeColors(
                "#000000", "#000000", "#0A0A0A", "#141414", "#B4B4B4", "#0A0A0A", "#1E1E1E"),
            "Void" => new ThemeColors(
                "#0A0514", "#0F0A1E", "#140F28", "#190F50", "#B4AADC", "#140F28", "#281E46"),
            "VioletSorrow" => new ThemeColors(
                "#120A23", "#160C2A", "#1C1234", "#411E78", "#B9AAD7", "#201439", "#4B3273"),
            "OrangeBurnout" => new ThemeColors(
                "#230F05", "#2A1408", "#32190A", "#CC5500", "#FFE4D1", "#32190A", "#6E2D0F"),
            "PurpleGrief" => new ThemeColors(
                "#190F1E", "#1E1423", "#231928", "#462850", "#DCC8E6", "#231928", "#50325A"),
            _ => new ThemeColors(
                "#1E1E1E", "#1E1E1E", "#252526", "#505050", "#D4D4D4", "#252526", "#3E3E42")
        };
    }

    public record ThemeColors(
        string WindowBg,
        string EditorBg,
        string TitleBar,
        string StatusBar,
        string Text,
        string TabBg,
        string SelectedTab);
}