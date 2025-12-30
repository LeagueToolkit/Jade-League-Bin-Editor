using System;
using System.IO;
using System.Windows;
using System.Windows.Media.Imaging;

namespace Jade.Services;

public static class IconService
{
    private const string IconPreferenceKey = "CustomIconPath";

    public static string? GetCustomIconPath()
    {
        string path = ThemeHelper.ReadPreference(IconPreferenceKey, "");
        return string.IsNullOrEmpty(path) ? null : path;
    }

    public static void SetCustomIconPath(string path)
    {
        ThemeHelper.WritePreference(IconPreferenceKey, path);
        ApplyIconToAllWindows();
        UpdateFileAssociationIcon();
    }

    public static void UpdateFileAssociationIcon()
    {
        try
        {
            string? iconPath = GetCustomIconPath();
            if (string.IsNullOrEmpty(iconPath))
            {
                iconPath = System.Diagnostics.Process.GetCurrentProcess().MainModule?.FileName;
                if (iconPath != null) iconPath += ",0";
            }

            if (string.IsNullOrEmpty(iconPath)) return;

            // Update registry for Jade.BinFile DefaultIcon
            using (var key = Microsoft.Win32.Registry.CurrentUser.CreateSubKey(@"Software\Classes\Jade.BinFile\DefaultIcon"))
            {
                key?.SetValue("", iconPath);
            }

            // Refresh shell icons
            RefreshShellIcons();
            Logger.Info("Updated file association icon in registry");
        }
        catch (Exception ex)
        {
            Logger.Error("Failed to update file association icon", ex);
        }
    }

    private static void RefreshShellIcons()
    {
        try
        {
            SHChangeNotify(0x08000000, 0x0000, IntPtr.Zero, IntPtr.Zero);
        }
        catch { }
    }

    [System.Runtime.InteropServices.DllImport("shell32.dll", CharSet = System.Runtime.InteropServices.CharSet.Auto, SetLastError = true)]
    private static extern void SHChangeNotify(int wEventId, int uFlags, IntPtr dwItem1, IntPtr dwItem2);

    public static void ApplyIconToWindow(Window window)
    {
        try
        {
            var icon = GetAppIcon();
            if (icon != null)
            {
                window.Icon = icon;
                
                // Also update any Image elements named TitleBarIcon or AppLogoImage
                if (window.FindName("TitleBarIcon") is System.Windows.Controls.Image titleBarIcon)
                {
                    titleBarIcon.Source = icon;
                }
                if (window.FindName("AppLogoImage") is System.Windows.Controls.Image appLogoImage)
                {
                    appLogoImage.Source = icon;
                }
            }
        }
        catch (Exception ex)
        {
            Logger.Error("Failed to apply custom icon to window", ex);
        }
    }

    public static void ApplyIconToAllWindows()
    {
        foreach (Window window in Application.Current.Windows)
        {
            ApplyIconToWindow(window);
        }
    }

    public static BitmapImage? GetAppIcon()
    {
        try
        {
            string? path = GetCustomIconPath();
            if (path != null && File.Exists(path))
            {
                var bitmap = new BitmapImage();
                bitmap.BeginInit();
                bitmap.UriSource = new Uri(path, UriKind.Absolute);
                bitmap.CacheOption = BitmapCacheOption.OnLoad;
                bitmap.EndInit();
                return bitmap;
            }
        }
        catch (Exception ex)
        {
            Logger.Error("Failed to load custom icon", ex);
        }

        try
        {
            return new BitmapImage(new Uri("pack://application:,,,/jade.ico"));
        }
        catch
        {
            return null;
        }
    }
}
