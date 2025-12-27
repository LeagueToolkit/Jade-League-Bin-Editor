using System;
using System.Reflection;
using System.Windows;
using System.Windows.Input;
using System.ComponentModel;

namespace Jade.Windows;

public partial class AboutWindow : Window
{
    public AboutWindow()
    {
        InitializeComponent();
        
        // Get version from assembly
        var version = Assembly.GetExecutingAssembly().GetName().Version;
        VersionText.Text = version != null ? $"{version.Major}.{version.Minor}.{version.Build}" : "1.0.0";
        
        // NO THEME CODE NEEDED! The window automatically uses DynamicResource bindings
    }
    
    private void OnClose(object sender, RoutedEventArgs e)
    {
        Close();
    }
    
    private void TitleBar_MouseLeftButtonDown(object sender, MouseButtonEventArgs e)
    {
        DragMove();
    }
}