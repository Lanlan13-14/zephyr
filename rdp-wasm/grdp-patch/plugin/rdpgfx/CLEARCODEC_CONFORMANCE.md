# RDPGFX ClearCodec conformance gate

Sources:
- MS-RDPEGFX section 4.1.1.1, Examples 2–4
- FreeRDP `libfreerdp/codec/clear.c`
- FreeRDP `libfreerdp/codec/test/TestFreeRDPCodecClear.c`

The input fixtures in `testdata/clear{2,3,4}.bin` are copied byte-for-byte
from the Microsoft examples embedded in the FreeRDP test.

Expected FreeRDP XRGB32/BGRA output hashes:

| Example | Size | SHA-256 |
|---|---:|---|
| 2 | 78×17 | `bd2382d2ccf18abdfdde44e654b8cce8538ae8c827c78855c4f854409f5171fe` |
| 3 | 64×24 | `0dfd368cc062233595578cb1c73e79d584394dcf1fb919559ed58a1725632835` |
| 4 | 7×15 | `b63f1237fc31a516336b3e09848c9206a1430be6a7d350b9481a458d53dd199d` |

No ClearCodec implementation may be wired into WIRE_TO_SURFACE_1 until all
three pixel hashes match exactly. A parser that merely returns a non-empty
buffer is not accepted.
