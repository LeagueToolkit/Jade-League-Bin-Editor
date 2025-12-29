using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime;
using System.Threading.Tasks;
using Jade.Services;

namespace Jade.Ritobin;

public static class HashManager
{
    private static uint[] _fnvKeys = Array.Empty<uint>();
    private static long[] _fnvData = Array.Empty<long>(); 

    private static ulong[] _xxhKeys = Array.Empty<ulong>();
    private static long[] _xxhData = Array.Empty<long>();

    private static byte[] _stringStorage = Array.Empty<byte>();
    private static int _storageOffset = 0;
    
    private static bool _loaded = false;
    private static readonly object _lock = new();
    private static Task? _loadingTask = null;

    public static void Load(string hashDir)
    {
        if (_loaded) return;

        lock (_lock)
        {
            if (_loaded) return;
            if (!Directory.Exists(hashDir)) return;

            Logger.Info("HashManager: Starting intelligent hash load...");

            // 1. Identify unique files (Prefer .bin over .txt)
            var allFiles = Directory.GetFiles(hashDir);
            var filesToLoad = new List<string>();
            var baseNames = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

            // First pass: find all .bin files
            foreach (var f in allFiles)
            {
                var fileName = Path.GetFileName(f);
                if (fileName.StartsWith("hashes.game.", StringComparison.OrdinalIgnoreCase)) continue;

                if (f.EndsWith(".bin", StringComparison.OrdinalIgnoreCase))
                {
                    filesToLoad.Add(f);
                    baseNames.Add(Path.GetFileNameWithoutExtension(f));
                }
            }
            // Second pass: add .txt files ONLY if no .bin exists
            foreach (var f in allFiles)
            {
                var fileName = Path.GetFileName(f);
                if (fileName.StartsWith("hashes.game.", StringComparison.OrdinalIgnoreCase)) continue;

                if (f.EndsWith(".txt", StringComparison.OrdinalIgnoreCase))
                {
                    if (!baseNames.Contains(Path.GetFileNameWithoutExtension(f)))
                    {
                        filesToLoad.Add(f);
                    }
                }
            }

            int totalFnvCount = 0;
            int totalXxhCount = 0;
            long exactStringSize = 0;

            // 2. Precise Pre-scan for exact allocation
            foreach (var file in filesToLoad)
            {
                try
                {
                    if (file.EndsWith(".bin", StringComparison.OrdinalIgnoreCase))
                    {
                        using var fs = File.OpenRead(file);
                        using var reader = new BinaryReader(fs);
                        if (fs.Length < 12 || new string(reader.ReadChars(4)) != "HHSH") continue;
                        reader.ReadInt32(); // Version
                        int fnv = reader.ReadInt32();
                        int xxh = reader.ReadInt32();
                        totalFnvCount += fnv;
                        totalXxhCount += xxh;
                        
                        // We can't easily skip-scan binary string lengths without reading them all
                        // but since we aren't loading duplicates anymore, estimating from file size 
                        // is now safe and won't cause the 500MB peak.
                        exactStringSize += fs.Length; 
                    }
                    else
                    {
                        exactStringSize += new FileInfo(file).Length;
                    }
                }
                catch { }
            }

            // 3. Allocate final arrays
            _fnvKeys = new uint[totalFnvCount];
            _fnvData = new long[totalFnvCount];
            _xxhKeys = new ulong[totalXxhCount];
            _xxhData = new long[totalXxhCount];
            _stringStorage = new byte[exactStringSize];
            
            int fIdx = 0;
            int xIdx = 0;
            _storageOffset = 0;

            // 4. Load data directly
            foreach (var file in filesToLoad)
            {
                if (file.EndsWith(".bin", StringComparison.OrdinalIgnoreCase))
                    LoadBinary(file, ref fIdx, ref xIdx);
                else
                    LoadText(file, ref fIdx, ref xIdx);
            }

            // 5. Finalize arrays
            if (fIdx < _fnvKeys.Length) { Array.Resize(ref _fnvKeys, fIdx); Array.Resize(ref _fnvData, fIdx); }
            if (xIdx < _xxhKeys.Length) { Array.Resize(ref _xxhKeys, xIdx); Array.Resize(ref _xxhData, xIdx); }

            Array.Sort(_fnvKeys, _fnvData);
            Array.Sort(_xxhKeys, _xxhData);

            // 6. Final Trim
            if (_storageOffset < _stringStorage.Length)
            {
                byte[] final = new byte[_storageOffset];
                Buffer.BlockCopy(_stringStorage, 0, final, 0, _storageOffset);
                _stringStorage = final;
            }

            _loaded = true;
            Logger.Info($"HashManager: Loaded {fIdx + xIdx} hashes. String buffer: {_storageOffset / 1024 / 1024}MB.");
        }
    }

    private static void LoadBinary(string file, ref int fIdx, ref int xIdx)
    {
        using var fs = File.OpenRead(file);
        using var reader = new BinaryReader(fs);
        reader.BaseStream.Position = 8;
        int fnvCount = reader.ReadInt32();
        int xxhCount = reader.ReadInt32();

        for (int i = 0; i < fnvCount; i++)
        {
            if (fIdx >= _fnvKeys.Length) break;
            _fnvKeys[fIdx] = reader.ReadUInt32();
            int len = Read7BitEncodedInt(reader);
            _fnvData[fIdx] = ((long)_storageOffset << 16) | (ushort)len;
            reader.Read(_stringStorage, _storageOffset, len);
            _storageOffset += len;
            fIdx++;
        }

        for (int i = 0; i < xxhCount; i++)
        {
            if (xIdx >= _xxhKeys.Length) break;
            _xxhKeys[xIdx] = reader.ReadUInt64();
            int len = Read7BitEncodedInt(reader);
            _xxhData[xIdx] = ((long)_storageOffset << 16) | (ushort)len;
            reader.Read(_stringStorage, _storageOffset, len);
            _storageOffset += len;
            xIdx++;
        }
    }

    private static void LoadText(string file, ref int fIdx, ref int xIdx)
    {
        foreach (var line in File.ReadLines(file))
        {
            if (string.IsNullOrWhiteSpace(line)) continue;
            int space = line.IndexOf(' ');
            if (space <= 0 || space >= line.Length - 1) continue;
            ReadOnlySpan<char> hSpan = line.AsSpan(0, space);
            byte[] bytes = System.Text.Encoding.UTF8.GetBytes(line.Substring(space + 1));
            if (hSpan.Length == 16 && ulong.TryParse(hSpan, System.Globalization.NumberStyles.HexNumber, null, out var h64))
            {
                if (xIdx >= _xxhKeys.Length) break;
                _xxhKeys[xIdx] = h64;
                _xxhData[xIdx] = ((long)_storageOffset << 16) | (ushort)bytes.Length;
                Buffer.BlockCopy(bytes, 0, _stringStorage, _storageOffset, bytes.Length);
                _storageOffset += bytes.Length; xIdx++;
            }
            else if (hSpan.Length == 8 && uint.TryParse(hSpan, System.Globalization.NumberStyles.HexNumber, null, out var h32))
            {
                if (fIdx >= _fnvKeys.Length) break;
                _fnvKeys[fIdx] = h32;
                _fnvData[fIdx] = ((long)_storageOffset << 16) | (ushort)bytes.Length;
                Buffer.BlockCopy(bytes, 0, _stringStorage, _storageOffset, bytes.Length);
                _storageOffset += bytes.Length; fIdx++;
            }
        }
    }

    private static int Read7BitEncodedInt(BinaryReader reader)
    {
        int count = 0, shift = 0; byte b;
        do { b = reader.ReadByte(); count |= (b & 0x7F) << shift; shift += 7; } while ((b & 0x80) != 0);
        return count;
    }

    public static string? GetFNV1a(uint hash)
    {
        if (!_loaded || _fnvKeys.Length == 0) return null;
        int idx = Array.BinarySearch(_fnvKeys, hash);
        if (idx < 0) return null;
        long dat = _fnvData[idx];
        return System.Text.Encoding.UTF8.GetString(_stringStorage, (int)(dat >> 16), (ushort)(dat & 0xFFFF));
    }

    public static string? GetXXH64(ulong hash)
    {
        if (!_loaded || _xxhKeys.Length == 0) return null;
        int idx = Array.BinarySearch(_xxhKeys, hash);
        if (idx < 0) return null;
        long dat = _xxhData[idx];
        return System.Text.Encoding.UTF8.GetString(_stringStorage, (int)(dat >> 16), (ushort)(dat & 0xFFFF));
    }

    public static Task LoadAsync(string hashDir)
    {
        if (_loaded) return Task.CompletedTask;
        lock (_lock)
        {
            if (_loaded) return Task.CompletedTask;
            if (_loadingTask != null) return _loadingTask;
            _loadingTask = Task.Run(() => Load(hashDir));
            return _loadingTask;
        }
    }

    public static void Unload()
    {
        lock (_lock)
        {
            _fnvKeys = Array.Empty<uint>(); _fnvData = Array.Empty<long>();
            _xxhKeys = Array.Empty<ulong>(); _xxhData = Array.Empty<long>();
            _stringStorage = Array.Empty<byte>(); _storageOffset = 0;
            _loaded = false; _loadingTask = null;
        }
        ForceCollection();
    }

    public static void ForceCollection()
    {
        try {
            GCSettings.LargeObjectHeapCompactionMode = GCLargeObjectHeapCompactionMode.CompactOnce;
            GC.Collect(2, GCCollectionMode.Aggressive, true, true);
            GC.WaitForPendingFinalizers();
            GC.Collect(2, GCCollectionMode.Aggressive, true, true);
        } catch { }
    }

    public static bool IsLoaded => _loaded;
}
