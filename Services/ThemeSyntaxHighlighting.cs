using System;
using System.Windows.Media;
using ICSharpCode.AvalonEdit.Highlighting;
using ICSharpCode.AvalonEdit.Highlighting.Xshd;
using System.Xml;

namespace Jade.Services;

public static class ThemeSyntaxHighlighting
{
    public static IHighlightingDefinition GetHighlightingForTheme(string keyword, string comment, string stringColor, string number, string property)
    {
        var xshd = $@"<?xml version=""1.0""?>
<SyntaxDefinition name=""BinFile"" xmlns=""http://icsharpcode.net/sharpdevelop/syntaxdefinition/2008"">
    <Color name=""Comment"" foreground=""{comment}"" />
    <Color name=""String"" foreground=""{stringColor}"" />
    <Color name=""Keyword"" foreground=""{keyword}"" fontWeight=""bold"" />
    <Color name=""Number"" foreground=""{number}"" />
    <Color name=""Property"" foreground=""{property}"" />
    
    <RuleSet>
        <Span color=""Comment"" begin=""#"" />
        <Span color=""String"" multiline=""false"">
            <Begin>&quot;</Begin>
            <End>&quot;</End>
        </Span>
        
        <Rule color=""Property"">
            \b[\w\d_]+(?=\s*:)
        </Rule>
        
        <Keywords color=""Keyword"">
            <Word>string</Word>
            <Word>bool</Word>
            <Word>u8</Word>
            <Word>u16</Word>
            <Word>u32</Word>
            <Word>u64</Word>
            <Word>i8</Word>
            <Word>i16</Word>
            <Word>i32</Word>
            <Word>i64</Word>
            <Word>f32</Word>
            <Word>f64</Word>
            <Word>vec2</Word>
            <Word>vec3</Word>
            <Word>vec4</Word>
            <Word>list</Word>
            <Word>map</Word>
            <Word>option</Word>
            <Word>link</Word>
            <Word>embed</Word>
            <Word>hash</Word>
            <Word>flag</Word>
            <Word>pointer</Word>
            <Word>true</Word>
            <Word>false</Word>
            <Word>null</Word>
        </Keywords>
        
        <Rule color=""Number"">
            \b0[xX][0-9a-fA-F]+  # hex number
            |
            \b\d+\.?\d*([eE][+-]?\d+)?  # decimal number
        </Rule>
    </RuleSet>
</SyntaxDefinition>";

        using (var reader = new XmlTextReader(new System.IO.StringReader(xshd)))
        {
            return HighlightingLoader.Load(reader, HighlightingManager.Instance);
        }
    }
    

}
