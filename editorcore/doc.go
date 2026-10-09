// Package editorcore is the single text core shared by the desktop host and
// the Android host. It reimplements the Bettbox CodeForge text behaviour
// (rope indexing, selection, layout, viewport, folds, brackets, indent guides,
// local words, and bidi segmentation) in Go.
//
// Offsets are Unicode scalar values, matching ropey::Rope, not UTF-16 code
// units and not bytes. The document text itself is stored once, as UTF-8.
// Direction caches key on the document version, never on text length. Bidi
// segments are computed from the real Unicode bidi class of every scalar;
// there is no "32 scalars or shorter means LTR" shortcut.
package editorcore
