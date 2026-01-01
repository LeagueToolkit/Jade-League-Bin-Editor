using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.RegularExpressions;

namespace Jade.Ritobin
{
    public class VfxParser
    {
        public class ParsedData
        {
            public Dictionary<string, VfxSystem> Systems { get; set; } = new Dictionary<string, VfxSystem>();
            public List<string> SystemOrder { get; set; } = new List<string>();
        }

        public class VfxSystem
        {
            public string Name { get; set; } = string.Empty;
            public string DisplayName { get; set; } = string.Empty;
            public string RawContent { get; set; } = string.Empty;
            public int GlobalStartLine { get; set; } // 1-indexed
            public int GlobalEndLine { get; set; }   // 1-indexed
            public List<VfxEmitter> Emitters { get; set; } = new List<VfxEmitter>();
        }

        public class VfxEmitter
        {
            public string Name { get; set; } = string.Empty;
            public string RawContent { get; set; } = string.Empty;
            public int GlobalStartLine { get; set; } // 1-indexed
            public int GlobalEndLine { get; set; }   // 1-indexed (inclusive)

            // Properties
            public VfxProperty<Vec3>? BirthScale0 { get; set; }
            public VfxProperty<Vec3>? Scale0 { get; set; }
            public VfxProperty<float>? BindWeight { get; set; }
            public VfxProperty<Vec3>? TranslationOverride { get; set; }
            public VfxProperty<float>? ParticleLifetime { get; set; }
            public VfxProperty<float>? Lifetime { get; set; }
            public VfxProperty<float>? ParticleLinger { get; set; }
        }

        public class VfxProperty<T>
        {
            public T? ConstantValue { get; set; }
            public List<T> DynamicsValues { get; set; } = new List<T>();
            public string RawBlock { get; set; } = string.Empty;
            public int StartLine { get; set; }
            public int EndLine { get; set; }
        }

        public class Vec3
        {
            public float X { get; set; }
            public float Y { get; set; }
            public float Z { get; set; }

            public Vec3(float x, float y, float z) { X = x; Y = y; Z = z; }
            public Vec3() { }
            public override string ToString() => $"{{ {X}, {Y}, {Z} }}";
        }

        public static ParsedData Parse(string content)
        {
            var lines = content.Split(new[] { "\r\n", "\r", "\n" }, StringSplitOptions.None);
            var result = new ParsedData();

            var systemBlocks = FindSystemBlocks(lines);

            foreach (var block in systemBlocks)
            {
                var systemLines = lines.Skip(block.StartLine).Take(block.EndLine - block.StartLine + 1).ToArray();
                var rawContent = string.Join(Environment.NewLine, systemLines);
                
                var system = ParseSystem(systemLines, block.Name, block.StartLine + 1); // +1 because lines are 0-indexed but result uses 1-indexed for editor
                system.GlobalEndLine = block.EndLine + 1; // +1 for 1-based

                result.Systems[block.Name] = system;
                result.SystemOrder.Add(block.Name);
            }

            return result;
        }

        private struct BlockInfo
        {
            public string Name;
            public int StartLine;
            public int EndLine;
        }

        private static List<BlockInfo> FindSystemBlocks(string[] lines)
        {
            var blocks = new List<BlockInfo>();

            for (int i = 0; i < lines.Length; i++)
            {
                var line = lines[i];
                var match = Regex.Match(line, @"^\s*""?([^""=]+)""?\s*=\s*VfxSystemDefinitionData\s*\{");
                
                if (match.Success)
                {
                    string name = match.Groups[1].Value.Trim().Replace("\"", "");
                    int startLine = i;
                    int endLine = FindBlockEnd(lines, i);

                    blocks.Add(new BlockInfo { Name = name, StartLine = startLine, EndLine = endLine });
                    i = endLine;
                }
            }
            return blocks;
        }

        private static int FindBlockEnd(string[] lines, int startLine)
        {
            int bracketDepth = 0;
            bool foundFirstBracket = false;

            for (int i = startLine; i < lines.Length; i++)
            {
                var line = lines[i];
                var (opens, closes) = CountBrackets(line);

                bracketDepth += opens - closes;

                if (opens > 0) foundFirstBracket = true;

                if (foundFirstBracket && bracketDepth == 0)
                {
                    return i;
                }
            }

            return lines.Length - 1;
        }

        private static (int opens, int closes) CountBrackets(string line)
        {
            int opens = 0;
            int closes = 0;
            bool inString = false;
            char? stringChar = null;

            for (int i = 0; i < line.Length; i++)
            {
                char c = line[i];
                char prev = i > 0 ? line[i - 1] : '\0';

                if ((c == '"' || c == '\'') && prev != '\\')
                {
                    if (!inString)
                    {
                        inString = true;
                        stringChar = c;
                    }
                    else if (c == stringChar)
                    {
                        inString = false;
                        stringChar = null;
                    }
                }

                if (!inString)
                {
                    if (c == '{') opens++;
                    if (c == '}') closes++;
                }
            }
            return (opens, closes);
        }

        private static VfxSystem ParseSystem(string[] lines, string name, int globalStartOffset)
        {
            string? particleName = null;
            var fullText = string.Join(Environment.NewLine, lines);
            var match = Regex.Match(fullText, @"particleName:\s*string\s*=\s*""([^""]+)""");
            if (match.Success)
            {
                particleName = match.Groups[1].Value;
            }

            var system = new VfxSystem
            {
                Name = name,
                DisplayName = particleName ?? GetShortName(name),
                RawContent = fullText,
                GlobalStartLine = globalStartOffset
            };

            var emitterBlocks = FindEmitterBlocks(lines);

            foreach (var block in emitterBlocks)
            {
                var emitterLines = lines.Skip(block.StartLine).Take(block.EndLine - block.StartLine + 1).ToArray();
                var emitterRaw = string.Join(Environment.NewLine, emitterLines);
                
                int emitterGlobalStart = globalStartOffset + block.StartLine;
                int emitterGlobalEnd = globalStartOffset + block.EndLine;

                var emitter = ParseEmitter(emitterLines, emitterGlobalStart);
                emitter.GlobalEndLine = emitterGlobalEnd;
                
                system.Emitters.Add(emitter);
            }

            return system;
        }

        private static List<BlockInfo> FindEmitterBlocks(string[] lines)
        {
            var blocks = new List<BlockInfo>();

            for (int i = 0; i < lines.Length; i++)
            {
                if (Regex.IsMatch(lines[i], @"VfxEmitterDefinitionData\s*\{"))
                {
                    int startLine = i;
                    int endLine = FindBlockEnd(lines, i);
                    blocks.Add(new BlockInfo { StartLine = startLine, EndLine = endLine });
                    i = endLine;
                }
            }
            return blocks;
        }

        private static VfxEmitter ParseEmitter(string[] lines, int globalStartLine)
        {
            var rawContent = string.Join(Environment.NewLine, lines);
            
            var emitter = new VfxEmitter
            {
                Name = "Unnamed",
                RawContent = rawContent,
                GlobalStartLine = globalStartLine
            };

            var match = Regex.Match(rawContent, @"emitterName:\s*string\s*=\s*""([^""]+)""");
            if (match.Success) emitter.Name = match.Groups[1].Value;

            emitter.BirthScale0 = ParseVec3Property(lines, "birthScale0", globalStartLine);
            emitter.Scale0 = ParseVec3Property(lines, "scale0", globalStartLine);
            
            emitter.BindWeight = ParseFloatProperty(lines, "bindWeight", globalStartLine);
            
            emitter.TranslationOverride = ParseSimpleVec3(lines, "translationOverride", globalStartLine);
            
            emitter.ParticleLifetime = ParseFloatProperty(lines, "particleLifetime", globalStartLine);
            
            emitter.Lifetime = ParseOptionFloat(lines, "lifetime", globalStartLine);
            emitter.ParticleLinger = ParseOptionFloat(lines, "particleLinger", globalStartLine);

            return emitter;
        }

        private static VfxProperty<Vec3>? ParseVec3Property(string[] lines, string propName, int globalOffset)
        {
            for (int i = 0; i < lines.Length; i++)
            {
                if (Regex.IsMatch(lines[i], $@"{propName}:\s*embed\s*=\s*ValueVector3\s*\{{"))
                {
                    int startRel = i;
                    int endRel = FindBlockEnd(lines, i);
                    
                    var blockLines = lines.Skip(startRel).Take(endRel - startRel + 1).ToArray();
                    var blockContent = string.Join(Environment.NewLine, blockLines);

                    var prop = new VfxProperty<Vec3>
                    {
                        StartLine = globalOffset + startRel,
                        EndLine = globalOffset + endRel,
                        RawBlock = blockContent,
                        ConstantValue = null
                    };

                    var constMatch = Regex.Match(blockContent, @"constantValue:\s*vec3\s*=\s*\{\s*([^}]+)\}");
                    if (constMatch.Success)
                    {
                        var parts = constMatch.Groups[1].Value.Split(',').Select(s => float.TryParse(s.Trim(), out float v) ? v : 0f).ToList();
                        if (parts.Count >= 3) prop.ConstantValue = new Vec3(parts[0], parts[1], parts[2]);
                    }

                    return prop;
                }
            }
            return null;
        }

        private static VfxProperty<float>? ParseFloatProperty(string[] lines, string propName, int globalOffset)
        {
             for (int i = 0; i < lines.Length; i++)
            {
                if (Regex.IsMatch(lines[i], $@"{propName}:\s*embed\s*=\s*ValueFloat\s*\{{"))
                {
                     int startRel = i;
                    int endRel = FindBlockEnd(lines, i);
                    
                    var blockLines = lines.Skip(startRel).Take(endRel - startRel + 1).ToArray();
                    var blockContent = string.Join(Environment.NewLine, blockLines);

                    var prop = new VfxProperty<float>
                    {
                        StartLine = globalOffset + startRel,
                        EndLine = globalOffset + endRel,
                        RawBlock = blockContent
                    };

                    var constMatch = Regex.Match(blockContent, @"constantValue:\s*f32\s*=\s*(-?[\d.]+)");
                    if (constMatch.Success && float.TryParse(constMatch.Groups[1].Value, out float val))
                    {
                        prop.ConstantValue = val;
                    }
                    return prop;
                }
            }
            return null;
        }

        private static VfxProperty<float>? ParseOptionFloat(string[] lines, string propName, int globalOffset)
        {
             for (int i = 0; i < lines.Length; i++)
            {
                var match = Regex.Match(lines[i], $@"{propName}:\s*option\[f32\]\s*=\s*\{{\s*([\d.\-]+)\s*\}}");
                if (match.Success)
                {
                    if (float.TryParse(match.Groups[1].Value, out float val))
                    {
                         return new VfxProperty<float>
                        {
                            StartLine = globalOffset + i,
                            EndLine = globalOffset + i,
                            RawBlock = lines[i],
                            ConstantValue = val
                        };
                    }
                }
            }
            return null;
        }

        private static VfxProperty<Vec3>? ParseSimpleVec3(string[] lines, string propName, int globalOffset)
        {
             for (int i = 0; i < lines.Length; i++)
            {
                var match = Regex.Match(lines[i], $@"{propName}:\s*vec3\s*=\s*\{{\s*([^}}]+)\}}");
                if (match.Success)
                {
                    var parts = match.Groups[1].Value.Split(',').Select(s => float.TryParse(s.Trim(), out float v) ? v : 0f).ToList();
                    if (parts.Count >= 3)
                    {
                        return new VfxProperty<Vec3>
                        {
                            StartLine = globalOffset + i,
                            EndLine = globalOffset + i,
                            RawBlock = lines[i],
                            ConstantValue = new Vec3(parts[0], parts[1], parts[2])
                        };
                    }
                }
            }
            return null;
        }

        private static string GetShortName(string fullPath)
        {
            if (string.IsNullOrEmpty(fullPath)) return "Unknown";
            var parts = fullPath.Split('/');
            var name = parts.Last();
            name = Regex.Replace(name, @"^[A-Z][a-z]+_(Base_|Skin\d+_)", "", RegexOptions.IgnoreCase);
            if (name.Length > 35) name = name.Substring(0, 32) + "...";
            return name;
        }
    }
}
