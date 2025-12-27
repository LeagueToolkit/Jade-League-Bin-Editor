using System;
using System.IO;
using System.Windows;
using System.Windows.Input;
using System.Windows.Media;
using Jade.Services;

namespace Jade.Windows;

public partial class ParticlePanelDialog : Window
{
    private readonly System.Windows.Controls.Primitives.ToggleButton _iconButton;
    private readonly MainWindow _mainWindow;
    
    public ParticlePanelDialog(System.Windows.Controls.Primitives.ToggleButton iconButton, MainWindow mainWindow)
    {
        InitializeComponent();
        _iconButton = iconButton;
        _mainWindow = mainWindow;
        
        Loaded += (s, e) =>
        {
            PositionUnderButton();
        };
    }
    
    private void PositionUnderButton()
    {
        try
        {
            if (Owner != null && _iconButton != null)
            {
                // Get button position relative to screen
                var buttonPosition = _iconButton.PointToScreen(new Point(0, 0));
                
                // Position dialog centered under the button, with padding from right edge
                var buttonCenterX = buttonPosition.X + (_iconButton.ActualWidth / 2);
                var dialogCenterX = ActualWidth / 2;
                Left = buttonCenterX - dialogCenterX;
                Top = buttonPosition.Y + _iconButton.ActualHeight + 5; // 5px gap
                
                // Make sure it doesn't go off screen or overlap scrollbar
                var screenWidth = SystemParameters.PrimaryScreenWidth;
                var screenHeight = SystemParameters.PrimaryScreenHeight;
                var scrollbarPadding = 30; // Extra padding to avoid scrollbar
                
                if (Left < 10) Left = 10;
                if (Top < 10) Top = 10;
                if (Left + ActualWidth > screenWidth - scrollbarPadding) 
                    Left = screenWidth - ActualWidth - scrollbarPadding;
                if (Top + ActualHeight > screenHeight) 
                    Top = screenHeight - ActualHeight - 10;
            }
        }
        catch (Exception ex)
        {
            Logger.Error("Failed to position particle panel dialog", ex);
        }
    }
    
    private void TitleBar_MouseLeftButtonDown(object sender, MouseButtonEventArgs e)
    {
        if (e.ClickCount == 2)
        {
            return; // No maximize for this dialog
        }
        else
        {
            DragMove();
        }
    }
}
