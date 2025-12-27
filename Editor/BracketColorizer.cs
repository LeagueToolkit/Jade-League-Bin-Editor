using System;
using System.Collections.Generic;
using System.Linq;
using System.Windows.Media;
using ICSharpCode.AvalonEdit.Document;
using ICSharpCode.AvalonEdit.Rendering;

namespace Jade.Editor;

public class BracketColorizer : DocumentColorizingTransformer
{
    private readonly Color[] _bracketColors;
    private readonly SolidColorBrush[] _frozenBrushes;
    
    // Cache: maps line number -> bracket depth at start of that line
    private readonly Dictionary<int, int> _depthCache = new();
    private int _cachedDocumentVersion = -1;
    
    public BracketColorizer(Color[] bracketColors)
    {
        _bracketColors = bracketColors;
        // Pre-cache and freeze brushes to avoid allocations during rendering
        _frozenBrushes = _bracketColors.Select(c => {
            var brush = new SolidColorBrush(c);
            brush.Freeze();
            return brush;
        }).ToArray();
    }
    
    protected override void ColorizeLine(DocumentLine line)
    {
        var document = CurrentContext.Document;
        int lineNumber = line.LineNumber;
        
        // Check if document changed - invalidate cache if so
        int currentVersion = document.Version.GetHashCode();
        if (currentVersion != _cachedDocumentVersion)
        {
            _depthCache.Clear();
            _cachedDocumentVersion = currentVersion;
        }
        
        // Get bracket depth at start of this line (cached or calculated)
        int currentDepth = GetBracketDepthAtLine(document, lineNumber);
        
        // Cache the depth for this line
        _depthCache[lineNumber] = currentDepth;
        
        string text = document.GetText(line);
        int lineStartOffset = line.Offset;
        
        for (int i = 0; i < text.Length; i++)
        {
            char c = text[i];
            
            if (c == '{' || c == '[' || c == '(')
            {
                int colorIndex = currentDepth % _frozenBrushes.Length;
                ChangeLinePart(
                    lineStartOffset + i,
                    lineStartOffset + i + 1,
                    element =>
                    {
                        element.TextRunProperties.SetForegroundBrush(_frozenBrushes[colorIndex]);
                    });
                currentDepth++;
            }
            else if (c == '}' || c == ']' || c == ')')
            {
                currentDepth--;
                if (currentDepth < 0) currentDepth = 0;
                
                int colorIndex = currentDepth % _frozenBrushes.Length;
                ChangeLinePart(
                    lineStartOffset + i,
                    lineStartOffset + i + 1,
                    element =>
                    {
                        element.TextRunProperties.SetForegroundBrush(_frozenBrushes[colorIndex]);
                    });
            }
        }
        
        // Cache the depth at the END of this line (for next line lookup)
        _depthCache[lineNumber + 1] = currentDepth;
    }
    
    /// <summary>
    /// Get bracket depth at start of a line, using cache if available.
    /// If not cached, finds the nearest cached line and calculates from there.
    /// </summary>
    private int GetBracketDepthAtLine(TextDocument document, int targetLine)
    {
        // Try direct cache hit
        if (_depthCache.TryGetValue(targetLine, out int cachedDepth))
            return cachedDepth;
        
        // Find the nearest cached line before this one
        int nearestCachedLine = 0;
        int nearestDepth = 0;
        
        foreach (var kvp in _depthCache)
        {
            if (kvp.Key <= targetLine && kvp.Key > nearestCachedLine)
            {
                nearestCachedLine = kvp.Key;
                nearestDepth = kvp.Value;
            }
        }
        
        // Calculate from nearest cached line to target
        int depth = nearestDepth;
        int startOffset = nearestCachedLine > 0 ? document.GetLineByNumber(nearestCachedLine).Offset : 0;
        int endOffset = document.GetLineByNumber(targetLine).Offset;
        
        for (int i = startOffset; i < endOffset; i++)
        {
            char c = document.GetCharAt(i);
            if (c == '{' || c == '[' || c == '(')
                depth++;
            else if (c == '}' || c == ']' || c == ')')
                depth = Math.Max(0, depth - 1);
        }
        
        return depth;
    }
}

