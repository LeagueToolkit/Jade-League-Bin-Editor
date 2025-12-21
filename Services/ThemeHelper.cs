using System;
using System.IO;
using System.Windows.Media;

namespace Jade.Services;

public static class ThemeHelper
{
    private static string GetPreferencesFilePath()
    {
        var appDataPath = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
        var prefsFolder = Path.Combine(appDataPath, "RitoShark", "Jade");
        
        if (!Directory.Exists(prefsFolder))
        {
            Directory.CreateDirectory(prefsFolder);
        }
        
        return Path.Combine(prefsFolder, "preferences.txt");
    }

    public static string ReadPreference(string key, string defaultValue)
    {
        try
        {
            var prefsFile = GetPreferencesFilePath();
            if (!File.Exists(prefsFile)) return defaultValue;

            var lines = File.ReadAllLines(prefsFile);
            foreach (var line in lines)
            {
                var trimmedLine = line.Trim();
                if (trimmedLine.StartsWith($"{key}="))
                {
                    return trimmedLine.Substring(key.Length + 1).Trim();
                }
            }
        }
        catch { }
        return defaultValue;
    }

    public static SolidColorBrush GetBrushFromHex(string hex)
    {
        try
        {
            if (string.IsNullOrWhiteSpace(hex)) return Brushes.Transparent;
            if (!hex.StartsWith("#")) hex = "#" + hex;
            return (SolidColorBrush)new BrushConverter().ConvertFrom(hex)!;
        }
        catch
        {
            return Brushes.Transparent;
        }
    }

    public static SolidColorBrush GetBrighterBrush(SolidColorBrush brush, double factor)
    {
        try
        {
            var color = brush.Color;
            return new SolidColorBrush(Color.FromRgb(
                (byte)Math.Min(255, color.R * factor),
                (byte)Math.Min(255, color.G * factor),
                (byte)Math.Min(255, color.B * factor)));
        }
        catch { return brush; }
    }
    
    public static Color GetBrighterColor(Color color, double factor)
    {
        try
        {
            return Color.FromRgb(
                (byte)Math.Min(255, color.R * factor),
                (byte)Math.Min(255, color.G * factor),
                (byte)Math.Min(255, color.B * factor));
        }
        catch { return color; }
    }
}
