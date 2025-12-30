using System;
using System.Reflection;
using System.Windows;
using System.Windows.Input;
using System.ComponentModel;
using Jade.Services;

namespace Jade.Windows;

public partial class AboutWindow : Window
{
    public AboutWindow()
    {
        InitializeComponent();
        
        // Get version from assembly
        var version = Assembly.GetExecutingAssembly().GetName().Version;
        VersionText.Text = version != null ? $"{version.Major}.{version.Minor}.{version.Build}" : "1.0.0";
        
        // Apply custom icon if set
        IconService.ApplyIconToWindow(this);
        var customIcon = IconService.GetAppIcon();
        if (customIcon != null)
        {
            AppLogoImage.Source = customIcon;
        }

        // NO THEME CODE NEEDED! The window automatically uses DynamicResource bindings
    }

    private void OnIconClick(object sender, MouseButtonEventArgs e)
    {
        var dialog = new Microsoft.Win32.OpenFileDialog
        {
            Filter = "Icon files (*.ico)|*.ico",
            Title = "Select New Application Icon"
        };

        if (dialog.ShowDialog() == true)
        {
            IconService.SetCustomIconPath(dialog.FileName);
            
            // Update the preview image in the About window
            var newIcon = IconService.GetAppIcon();
            if (newIcon != null)
            {
                AppLogoImage.Source = newIcon;
            }
        }
    }
    
    private void OnClose(object sender, RoutedEventArgs e)
    {
        Close();
    }
    
    private void TitleBar_MouseLeftButtonDown(object sender, MouseButtonEventArgs e)
    {
        DragMove();
    }

    private void OnOpenGithub(object sender, RoutedEventArgs e)
    {
        try
        {
            System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo
            {
                FileName = "https://github.com/RitoShark/Jade-League-Bin-Editor",
                UseShellExecute = true
            });
        }
        catch (Exception ex)
        {
            MessageBox.Show($"Could not open link: {ex.Message}", "Error", MessageBoxButton.OK, MessageBoxImage.Error);
        }
    }
}