using System;
using System.IO;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using Jade.Services;

namespace Jade.Windows;

public partial class ReplaceDialog : Window
{
    private readonly dynamic _editor;
    private int _lastSearchIndex = 0;
    
    public ReplaceDialog(object editor)
    {
        InitializeComponent();
        _editor = editor;
        
        Loaded += (s, e) =>
        {
            PositionAtBottomRight();
            FindTextBox.Focus();
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
            Logger.Error("Failed to position replace dialog", ex);
        }
    }

    
    private void TitleBar_MouseLeftButtonDown(object sender, MouseButtonEventArgs e)
    {
        if (e.ClickCount == 2)
        {
            return; // No maximize for replace dialog
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
            e.Handled = true;
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
    
    private void OnReplace(object sender, RoutedEventArgs e)
    {
        try
        {
            var findText = FindTextBox.Text;
            var replaceText = ReplaceTextBox.Text;
            
            if (string.IsNullOrEmpty(findText))
            {
                MessageBox.Show("Please enter text to find.", "Replace", MessageBoxButton.OK, MessageBoxImage.Information);
                return;
            }
            
            // Check if current selection matches the find text
            var selectedText = _editor.SelectedText;
            var matchCase = MatchCaseCheckBox.IsChecked == true;
            var comparison = matchCase ? StringComparison.Ordinal : StringComparison.OrdinalIgnoreCase;
            
            if (!string.IsNullOrEmpty(selectedText) && selectedText.Equals(findText, comparison))
            {
                // Replace the selected text
                int selectionStart = _editor.SelectionStart;
                _editor.SelectedText = replaceText;
                _editor.SelectionStart = selectionStart;
                _editor.SelectionLength = replaceText.Length;
                
                Logger.Info($"Replaced text at position {selectionStart}");
            }
            
            // Find next occurrence
            FindText(forward: true);
        }
        catch (Exception ex)
        {
            Logger.Error("Error during replace operation", ex);
            MessageBox.Show($"Error during replace: {ex.Message}", "Error", MessageBoxButton.OK, MessageBoxImage.Error);
        }
    }
    
    private void OnReplaceAll(object sender, RoutedEventArgs e)
    {
        try
        {
            var findText = FindTextBox.Text;
            var replaceText = ReplaceTextBox.Text;
            
            if (string.IsNullOrEmpty(findText))
            {
                MessageBox.Show("Please enter text to find.", "Replace All", MessageBoxButton.OK, MessageBoxImage.Information);
                return;
            }
            
            if (string.IsNullOrEmpty(_editor.Text))
            {
                MessageBox.Show("No text to search.", "Replace All", MessageBoxButton.OK, MessageBoxImage.Information);
                return;
            }
            
            var document = _editor.Document;
            var editorText = document.Text;
            
            var matchCase = MatchCaseCheckBox.IsChecked == true;
            var wholeWord = WholeWordCheckBox.IsChecked == true;
            var comparison = matchCase ? StringComparison.Ordinal : StringComparison.OrdinalIgnoreCase;
            
            // Find all instances first
            var replacements = new System.Collections.Generic.List<int>();
            int searchIndex = 0;
            
            while (searchIndex < editorText.Length)
            {
                int foundIndex = editorText.IndexOf(findText, searchIndex, comparison);
                
                if (foundIndex == -1)
                    break;
                
                // Check whole word if needed
                if (wholeWord && !IsWholeWord(editorText, foundIndex, findText.Length))
                {
                    searchIndex = foundIndex + 1;
                    continue;
                }
                
                replacements.Add(foundIndex);
                searchIndex = foundIndex + findText.Length;
            }
            
            if (replacements.Count > 0)
            {
                // Group undo actions
                document.BeginUpdate();
                try
                {
                    // Replace backwards to keep offsets valid
                    for (int i = replacements.Count - 1; i >= 0; i--)
                    {
                        document.Replace(replacements[i], findText.Length, replaceText);
                    }
                }
                finally
                {
                    document.EndUpdate();
                }
                
                MessageBox.Show($"Replaced {replacements.Count} occurrence(s).", "Replace All", MessageBoxButton.OK, MessageBoxImage.Information);
                Logger.Info($"Replaced {replacements.Count} occurrences");
            }
            else
            {
                MessageBox.Show($"Cannot find \"{findText}\"", "Replace All", MessageBoxButton.OK, MessageBoxImage.Information);
            }
        }
        catch (Exception ex)
        {
            Logger.Error("Error during replace all operation", ex);
            MessageBox.Show($"Error during replace all: {ex.Message}", "Error", MessageBoxButton.OK, MessageBoxImage.Error);
        }
    }
    
    private void FindText(bool forward)
    {
        try
        {
            var searchText = FindTextBox.Text;
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
                startIndex = _editor.SelectionStart + _editor.SelectionLength;
                if (startIndex >= editorText.Length)
                {
                    startIndex = 0;
                }
            }
            else
            {
                startIndex = _editor.SelectionStart - 1;
                if (startIndex < 0)
                {
                    startIndex = editorText.Length - 1;
                }
            }
            
            int foundIndex = -1;
            
            if (forward)
            {
                foundIndex = editorText.IndexOf(searchText, startIndex, comparison);
                
                if (foundIndex == -1 && startIndex > 0)
                {
                    foundIndex = editorText.IndexOf(searchText, 0, comparison);
                }
            }
            else
            {
                foundIndex = editorText.LastIndexOf(searchText, startIndex, comparison);
                
                if (foundIndex == -1 && startIndex < editorText.Length - 1)
                {
                    foundIndex = editorText.LastIndexOf(searchText, comparison);
                }
            }
            
            if (foundIndex != -1)
            {
                if (wholeWord)
                {
                    bool isWholeWord = IsWholeWord(editorText, foundIndex, searchText.Length);
                    if (!isWholeWord)
                    {
                        _editor.SelectionStart = forward ? foundIndex + 1 : foundIndex - 1;
                        _editor.SelectionLength = 0;
                        FindText(forward);
                        return;
                    }
                }
                
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
        if (index > 0)
        {
            char before = text[index - 1];
            if (char.IsLetterOrDigit(before) || before == '_')
            {
                return false;
            }
        }
        
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
                    mainWindow.UpdateSearchHighlights(FindTextBox.Text, MatchCaseCheckBox.IsChecked == true, WholeWordCheckBox.IsChecked == true);
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
