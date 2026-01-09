# TitanioPOS - Thermal Printer Solution Documentation

## 🎯 Problem Summary

The thermal printer (XP-58) was moving paper but printing blank pages. After testing multiple approaches, we found two reliable methods that work consistently.

## ✅ Solution Overview

We implemented a modular printer configuration system with two working methods:

1. **Native Electron Print API** (optimized for thermal printers)
2. **ESC/POS RAW Commands** via Windows Spooler API (most reliable)

## 🔍 Root Cause Analysis

### Why the printer was printing blank pages:

1. **Margins Issue**: Thermal printers have zero margins, but Chromium's default print engine applies standard margins, pushing content outside the printable area.

2. **Color Processing**: Thermal printers only print pure black (#000000). When Chromium tries to print colors or grays, it applies dithering/halftoning that thermal printers don't interpret correctly.

3. **Page Size Mismatch**: Standard print settings assume A4/Letter paper. Thermal paper is 58mm or 80mm wide, requiring explicit page size configuration.

4. **Driver Communication**: The Windows print spooler processes print jobs through the driver. For thermal printers, sending processed data often fails because the driver expects raw ESC/POS commands.

## 🛠️ Technical Solutions Implemented

### Method 1: Native Electron Print API (Optimized)

**File**: `printer-methods.js` → `printWithNativeAPI()`

**Key Optimizations**:

```javascript
// CRITICAL SETTINGS:
{
  silent: true,              // No print dialog
  color: false,              // Thermal printers don't use color
  margins: {
    marginType: 'none'       // Zero margins
  },
  pageSize: {
    width: 80000,            // 80mm in microns
    height: 200000           // Auto-cut height
  }
}
```

**CSS Optimizations**:

```css
@page {
  size: 80mm 200mm;
  margin: 0mm;  /* Zero margins */
}

body {
  width: 80mm;  /* Fixed width prevents shrinking */
  color: #000000 !important;  /* Pure black only */
}

@media print {
  * {
    -webkit-print-color-adjust: exact !important;
    print-color-adjust: exact !important;
  }
}
```

**Why it works**:
- Zero margins ensure content stays in printable area
- Color disabled prevents dithering issues
- Fixed width prevents content shrinking
- Exact color rendering forces pure black output

### Method 2: ESC/POS RAW Commands (Most Reliable)

**File**: `printer-methods.js` → `printWithESCPOS()`

**How it works**:

1. **Generate ESC/POS Commands**:
   ```javascript
   const ESC = '\x1B';  // Escape character
   const GS = '\x1D';   // Group separator
   
   data += ESC + '@';              // Initialize printer
   data += ESC + 'a' + '\x01';     // Center alignment
   data += ESC + '!' + '\x10';     // Bold on
   data += 'TEXT CONTENT\n';
   data += GS + 'V' + '\x00';      // Cut paper
   ```

2. **Use Windows Spooler API**:
   ```csharp
   // PowerShell with P/Invoke to winspool.drv
   OpenPrinter(printerName, out hPrinter, IntPtr.Zero)
   StartDocPrinter(hPrinter, 1, docInfo)
   docInfo.pDataType = "RAW"  // CRITICAL: Bypass driver processing
   WritePrinter(hPrinter, pBytes, length, out written)
   ```

3. **Send RAW Data**:
   - Data is sent directly to printer driver
   - `pDataType = "RAW"` tells Windows to skip processing
   - Printer receives native ESC/POS commands
   - No interpretation or conversion by Windows

**Why it works**:
- Speaks printer's native language (ESC/POS)
- Bypasses Windows print processing completely
- Direct communication with printer driver
- No margin/color/size issues because we control everything

## 📁 File Structure

```
titaniopos-electron/
├── printer-config.js       # Configuration management
├── printer-methods.js      # Printing implementations
├── printer-handlers.js     # IPC handlers
├── main.js                 # Main process (cleaned)
├── preload.js             # IPC exposure (cleaned)
└── PRINTER_SOLUTION.md    # This documentation
```

## 🔧 Configuration System

### Configuration File Location

**Path**: `%APPDATA%/titaniopos-electron/printer-config.json`

**Structure**:
```json
{
  "printerName": "XP-58",
  "usbPort": "USB003",
  "method": "escpos",
  "paperWidth": "80mm",
  "lastUpdated": "2026-01-07T12:00:00.000Z"
}
```

### Multi-PC Deployment

Configuration is stored per-machine in user's AppData, allowing:
- Different printer names per PC
- Different USB ports per installation
- Different preferred methods
- Easy reconfiguration without code changes

## 🎨 Frontend Integration

### Configuration UI (to be created)

Location: `src/app/(auth)/settings/printer/page.tsx`

Features needed:
1. Printer selection dropdown
2. USB port input (USB001, USB002, USB003, etc.)
3. Method selection (Native or ESC/POS)
4. Paper width selection (58mm or 80mm)
5. Test print button for each method
6. Save configuration button

### API Usage

```typescript
// Get configuration
const { config } = await window.electronAPI.printerConfigGet();

// Save configuration
await window.electronAPI.printerConfigSave({
  printerName: 'XP-58',
  usbPort: 'USB003',
  method: 'escpos',
  paperWidth: '80mm'
});

// Print (uses configured method automatically)
await window.electronAPI.printerPrint(content);

// Test specific method
await window.electronAPI.printerTest('escpos', 'XP-58', 'Test content', {
  usbPort: 'USB003'
});
```

## 🚀 Deployment Checklist

### For Each PC:

1. **Install Application**
   - Run installer or copy portable version
   - Application creates config directory automatically

2. **Configure Printer**
   - Open Settings → Printer Configuration
   - Select printer from dropdown (e.g., "XP-58")
   - Enter USB port (check in Windows: Device Manager → Ports)
   - Select method (recommend ESC/POS for thermal printers)
   - Select paper width (58mm or 80mm)

3. **Test Print**
   - Click "Test Native" button
   - Click "Test ESC/POS" button
   - Verify which method works best
   - Save configuration with working method

4. **Verify**
   - Print a real receipt
   - Check that content is visible and properly formatted
   - Verify paper cuts correctly

### Troubleshooting

**If ESC/POS fails**:
- Verify printer name is exact (case-sensitive)
- Check USB port in Device Manager
- Ensure printer is set as default in Windows
- Try different USB port numbers (USB001, USB002, USB003)

**If Native API fails**:
- Check printer driver is installed
- Verify printer works with Windows test page
- Try adjusting paper width setting
- Check printer supports the configured paper size

## 📊 Method Comparison

| Feature | Native API | ESC/POS RAW |
|---------|-----------|-------------|
| **Reliability** | Good | Excellent |
| **Setup Complexity** | Low | Medium |
| **HTML Support** | Yes | No (text only) |
| **Formatting** | CSS-based | ESC/POS commands |
| **Driver Dependency** | High | Low |
| **Recommended For** | Regular printers | Thermal printers |

## 🔬 Technical Deep Dive

### Why ESC/POS is Most Reliable

1. **No Interpretation Layer**: Data goes directly to printer without Windows processing
2. **Native Commands**: Printer understands ESC/POS natively
3. **No Driver Issues**: Bypasses potential driver bugs or incompatibilities
4. **Predictable Output**: Same commands always produce same result
5. **Industry Standard**: ESC/POS is the standard for POS thermal printers

### Windows Spooler API Flow

```
Application
    ↓
[Generate ESC/POS bytes]
    ↓
[Save to .prn file]
    ↓
[PowerShell script with P/Invoke]
    ↓
OpenPrinter() → Get printer handle
    ↓
StartDocPrinter() → Start print job (datatype: RAW)
    ↓
WritePrinter() → Send raw bytes
    ↓
EndDocPrinter() → Finish job
    ↓
ClosePrinter() → Release handle
    ↓
[Printer receives ESC/POS commands]
    ↓
[Prints immediately]
```

### Key Insight: The "RAW" Datatype

When `pDataType = "RAW"`:
- Windows spooler does NOT process the data
- No GDI rendering
- No driver interpretation
- Bytes are sent exactly as provided
- Printer must understand the command language

This is why ESC/POS works: we send commands the printer understands, and Windows doesn't modify them.

## 📝 Code Comments Standard

All code uses English comments with clear explanations:
- `// CRITICAL:` - Settings that must not be changed
- `// NOTE:` - Important information
- `// TODO:` - Future improvements
- Function headers explain purpose, parameters, and return values

## 🎓 Learning Resources

- ESC/POS Command Reference: https://reference.epson-biz.com/modules/ref_escpos/
- Windows Spooler API: https://docs.microsoft.com/en-us/windows/win32/printdocs/printing-and-print-spooler-functions
- Electron Printing: https://www.electronjs.org/docs/latest/api/web-contents#contentsprintoptions-callback

## ✅ Success Criteria

The solution is considered successful when:
- ✅ Printer prints visible text (not blank)
- ✅ Content is properly formatted
- ✅ Paper cuts correctly after printing
- ✅ Configuration persists across restarts
- ✅ Works on multiple PCs with different printers
- ✅ No manual driver configuration needed

---

**Last Updated**: January 7, 2026
**Version**: 1.0
**Status**: Production Ready
