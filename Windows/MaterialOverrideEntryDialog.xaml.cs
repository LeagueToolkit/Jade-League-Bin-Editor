using System;
using System.IO;
using System.Windows;
using System.Windows.Input;
using System.Windows.Media;
using Jade.Services;

namespace Jade.Windows;

public partial class MaterialOverrideEntryDialog : Window
{
    public string PathValue { get; private set; } = "";
    public string SubmeshValue { get; private set; } = "";
    public bool Accepted { get; private set; }
    
    public MaterialOverrideEntryDialog(string entryType, string defaultPath = "")
    {
        InitializeComponent();
        
        TitleTextBlock.Text = entryType == "texture" ? "Add Texture Entry" : "Add Material Entry";
        PathLabelTextBlock.Text = entryType == "texture" ? "Texture Path:" : "Material Path:";
        PathTextBox.Text = defaultPath;
        
        Loaded += (s, e) =>
        {
            PositionToLeft();
        };
    }
    
    private void OnAccept(object sender, RoutedEventArgs e)
    {
        PathValue = PathTextBox.Text.Trim();
        SubmeshValue = SubmeshTextBox.Text.Trim();
        
        if (string.IsNullOrEmpty(PathValue))
        {
            MessageBox.Show("Path cannot be empty", "Validation Error", MessageBoxButton.OK, MessageBoxImage.Warning);
            return;
        }
        
        if (string.IsNullOrEmpty(SubmeshValue))
        {
            MessageBox.Show("Submesh cannot be empty", "Validation Error", MessageBoxButton.OK, MessageBoxImage.Warning);
            return;
        }
        
        Accepted = true;
        Close();
    }
    
    private void OnCancel(object sender, RoutedEventArgs e)
    {
        Accepted = false;
        Close();
    }
    
    private void PositionToLeft()
    {
        try
        {
            if (Owner != null)
            {
                // Position to the left of the owner window
                Left = Owner.Left - ActualWidth - 10;
                Top = Owner.Top + 50;
                
                // Make sure it doesn't go off screen
                if (Left < 10) Left = 10;
                if (Top < 10) Top = 10;
                if (Top + ActualHeight > SystemParameters.PrimaryScreenHeight)
                    Top = SystemParameters.PrimaryScreenHeight - ActualHeight - 10;
            }
        }
        catch (Exception ex)
        {
            Logger.Error("Failed to position material override entry dialog", ex);
        }
    }
    
    private void TitleBar_MouseLeftButtonDown(object sender, MouseButtonEventArgs e)
    {
        if (e.ClickCount == 2)
        {
            return;
        }
        else
        {
            DragMove();
        }
    }
}
