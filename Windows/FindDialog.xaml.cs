using System;
using System.IO;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using Jade.Services;

namespace Jade.Windows;

public partial class FindDialog : Window
{
    private readonly dynamic _editor;
    private int _lastSearchIndex = 0;
    
    public FindDialog(object editor)
    {
        InitializeComponent();
        _editor = editor;
        
        Loaded += (s, e) =>
        {
            PositionAtBottomRight();
            SearchTextBox.Focus();
        };
    }

    private void PositionAtBottomRight()
    {
        try
        {
            if (Owner != null)
            {
                var rightPadding = 20;
                var bottomPadding = 44;
                Left = Owner.Left + Owner.ActualWidth - ActualWidth - rightPadding;
                Top = Owner.Top + Owner.ActualHeight - ActualHeight - bottomPadding;
                
                var screenWidth = SystemParameters.PrimaryScreenWidth;
                var screenHeight = SystemParameters.PrimaryScreenHeight;
                
                if (Left < 0) Left = rightPadding;
                if (Top < 0) Top = rightPadding;
                if (Left + ActualWidth > screenWidth) Left = screenWidth - ActualWidth - rightPadding;
                if (Top + ActualHeight > screenHeight) Top = screenHeight - ActualHeight - bottomPadding;
            }
        }
        catch (Exception ex)
        {
            Logger.Error("Failed to position find dialog", ex);
        }
    }

    
    private void TitleBar_MouseLeftButtonDown(object sender, MouseButtonEventArgs e)
    {
        if (e.ClickCount == 2)
        {
            return; // No maximize for find dialog
        }
        else
        {
            DragMove();
        }
    }
    
    private void OnSearchKeyDown(object sender, KeyEventArgs e)
    {
        if (e.Key == Key.Enter)
        {
            e.Handled = true; // Prevent Enter from reaching the editor
            OnFindNext(sender, e);
        }
        else if (e.Key == Key.Escape)
        {
            e.Handled = true;
            var owner = Owner;
            Owner = null;
            owner?.Activate();
            Close();
        }
    }
    
    private void OnFindNext(object sender, RoutedEventArgs e)
    {
        FindText(forward: true);
    }
    
    private void OnFindPrevious(object sender, RoutedEventArgs e)
    {
        FindText(forward: false);
    }
    
    private void FindText(bool forward)
    {
        try
        {
            var searchText = SearchTextBox.Text;
            if (string.IsNullOrEmpty(searchText))
            {
                return;
            }
            
            var editorText = _editor.Text;
            if (string.IsNullOrEmpty(editorText))
            {
                MessageBox.Show("No text to search.", "Find", MessageBoxButton.OK, MessageBoxImage.Information);
                return;
            }
            
            var matchCase = MatchCaseCheckBox.IsChecked == true;
            var wholeWord = WholeWordCheckBox.IsChecked == true;
            
            var comparison = matchCase ? StringComparison.Ordinal : StringComparison.OrdinalIgnoreCase;
            
            int startIndex;
            if (forward)
            {
                // Start from current selection end or last search position
                startIndex = _editor.SelectionStart + _editor.SelectionLength;
                if (startIndex >= editorText.Length)
                {
                    startIndex = 0; // Wrap around
                }
            }
            else
            {
                // Start from current selection start
                startIndex = _editor.SelectionStart - 1;
                if (startIndex < 0)
                {
                    startIndex = editorText.Length - 1; // Wrap around
                }
            }
            
            int foundIndex = -1;
            
            if (forward)
            {
                foundIndex = editorText.IndexOf(searchText, startIndex, comparison);
                
                // Wrap around if not found
                if (foundIndex == -1 && startIndex > 0)
                {
                    foundIndex = editorText.IndexOf(searchText, 0, comparison);
                }
            }
            else
            {
                // Search backwards
                foundIndex = editorText.LastIndexOf(searchText, startIndex, comparison);
                
                // Wrap around if not found
                if (foundIndex == -1 && startIndex < editorText.Length - 1)
                {
                    foundIndex = editorText.LastIndexOf(searchText, comparison);
                }
            }
            
            if (foundIndex != -1)
            {
                // Check whole word if needed
                if (wholeWord)
                {
                    bool isWholeWord = IsWholeWord(editorText, foundIndex, searchText.Length);
                    if (!isWholeWord)
                    {
                        // Continue searching
                        _editor.SelectionStart = forward ? foundIndex + 1 : foundIndex - 1;
                        _editor.SelectionLength = 0;
                        FindText(forward);
                        return;
                    }
                }
                
                // Select the found text
                _editor.SelectionStart = foundIndex;
                _editor.SelectionLength = searchText.Length;
                _editor.Focus();
                _editor.ScrollToLine(GetLineNumber(editorText, foundIndex));
                
                _lastSearchIndex = foundIndex;
                
                Logger.Info($"Found text at index {foundIndex}");
            }
            else
            {
                MessageBox.Show($"Cannot find \"{searchText}\"", "Find", MessageBoxButton.OK, MessageBoxImage.Information);
                _lastSearchIndex = 0;
            }
        }
        catch (Exception ex)
        {
            Logger.Error("Error during find operation", ex);
            MessageBox.Show($"Error during search: {ex.Message}", "Error", MessageBoxButton.OK, MessageBoxImage.Error);
        }
    }
    
    private bool IsWholeWord(string text, int index, int length)
    {
        // Check if character before is not alphanumeric
        if (index > 0)
        {
            char before = text[index - 1];
            if (char.IsLetterOrDigit(before) || before == '_')
            {
                return false;
            }
        }
        
        // Check if character after is not alphanumeric
        int endIndex = index + length;
        if (endIndex < text.Length)
        {
            char after = text[endIndex];
            if (char.IsLetterOrDigit(after) || after == '_')
            {
                return false;
            }
        }
        
        return true;
    }
    
    private int GetLineNumber(string text, int index)
    {
        int lineNumber = 0;
        for (int i = 0; i < index && i < text.Length; i++)
        {
            if (text[i] == '\n')
            {
                lineNumber++;
            }
        }
        return lineNumber;
    }
    
    private void OnClose(object sender, RoutedEventArgs e)
    {
        var owner = Owner;
        Owner = null;
        owner?.Activate();
        Close();
    }

    private void OnSearchTextChanged(object sender, TextChangedEventArgs e)
    {
        UpdateHighlights();
    }
    
    private void OnOptionChanged(object sender, RoutedEventArgs e)
    {
        UpdateHighlights();
    }
    
    private void UpdateHighlights()
    {
        try
        {
            if (_editor is DependencyObject depObj)
            {
                var mainWindow = Window.GetWindow(depObj) as MainWindow;
                if (mainWindow != null)
                {
                    mainWindow.UpdateSearchHighlights(SearchTextBox.Text, MatchCaseCheckBox.IsChecked == true, WholeWordCheckBox.IsChecked == true);
                }
            }
        }
        catch (Exception ex)
        {
            Logger.Error("Failed to update highlights", ex);
        }
    }

    protected override void OnClosed(EventArgs e)
    {
        base.OnClosed(e);
        // Clear highlights
        try
        {
            if (_editor is DependencyObject depObj)
            {
                var mainWindow = Window.GetWindow(depObj) as MainWindow;
                if (mainWindow != null)
                {
                    mainWindow.UpdateSearchHighlights("", false, false);
                }
            }
        }
        catch { }
    }
}
