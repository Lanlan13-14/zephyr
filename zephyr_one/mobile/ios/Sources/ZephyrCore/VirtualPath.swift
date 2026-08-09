import Foundation

/// Virtual-path validation for the ZFT2 provider.
///
/// A port of `VirtualPath.kt`, and the port matters more than it looks: this is
/// the rule that decides which peer-supplied strings are allowed to name a file
/// inside the user's shared directory. DEVELOPMENT.md 13.4 requires NUL, empty
/// segments, `.`, `..`, absolute host paths and platform separator escapes to be
/// rejected *before* the path is mapped onto the authorised root, and it requires
/// Android and iOS to agree. Two ports that disagree here are two different jails
/// wearing one specification.
///
/// Pure logic, touching no filesystem, so it is unit-testable without a
/// security-scoped URL. Resolving symlinks and refusing the ones that leave the
/// root is the platform provider's job, because only it knows the real root --
/// and on iOS, unlike SAF, symlinks genuinely exist. See
/// `SecurityScopedFileProvider`.
public enum VirtualPath {

    /// Longest single segment. Guards against filesystem-specific name limits.
    public static let maxSegmentLength = 255

    /// Longest whole path. Bounds the work a hostile peer can force per frame.
    public static let maxPathLength = 4096

    /// Deepest nesting accepted. A path bomb is cheaper to reject than to walk.
    public static let maxDepth = 64

    /// Normalises a peer-supplied path to a canonical `/a/b` form.
    ///
    /// There is intentionally no "best effort" repair: silently rewriting a
    /// traversal attempt into a valid path is how jails are escaped, so a
    /// rejected path stays rejected.
    ///
    /// - Throws: `Zft2Error` with code `invalid_path`.
    public static func normalize(_ raw: String?) throws -> String {
        guard let input = raw else {
            throw Zft2Error(code: "invalid_path", message: "Path is required")
        }
        // Counted in UTF-8 bytes, matching the Kotlin port's intent of bounding
        // the work a frame can force. Counting Characters would let a path of
        // combining sequences carry several times the bytes for the same count.
        if input.utf8.count > maxPathLength {
            throw Zft2Error(code: "invalid_path", message: "Path is too long")
        }
        if input.contains("\0") {
            throw Zft2Error(code: "invalid_path", message: "Path contains NUL")
        }

        // Windows-style separators and drive letters never appear in a virtual
        // path. Accepting them would let a peer address the host filesystem on a
        // desktop provider, and the same frame reaches all four ports.
        if input.contains("\\") {
            throw Zft2Error(code: "invalid_path", message: "Backslash is not a path separator")
        }
        let scalars = Array(input)
        if scalars.count >= 2, scalars[1] == ":" {
            throw Zft2Error(code: "invalid_path", message: "Drive-letter paths are rejected")
        }
        // A UNC path would resolve off-device entirely.
        if input.hasPrefix("//") {
            throw Zft2Error(code: "invalid_path", message: "UNC paths are rejected")
        }

        let segments = input.split(separator: "/", omittingEmptySubsequences: true).map(String.init)
        if segments.count > maxDepth {
            throw Zft2Error(code: "invalid_path", message: "Path is too deep")
        }
        for segment in segments {
            if segment == "." || segment == ".." {
                throw Zft2Error(code: "invalid_path", message: "Relative segments are rejected")
            }
            if segment.utf8.count > maxSegmentLength {
                throw Zft2Error(code: "invalid_path", message: "Path segment is too long")
            }
            // Control characters are not legal in a shared file name and are a
            // classic way to spoof a name in the main end's file browser.
            for scalar in segment.unicodeScalars where scalar.value < 0x20 || scalar.value == 0x7f {
                throw Zft2Error(code: "invalid_path", message: "Path contains control characters")
            }
        }
        return segments.isEmpty ? "/" : "/" + segments.joined(separator: "/")
    }

    /// True when `candidate` is `root` itself or sits underneath it.
    ///
    /// Both arguments must already be normalised. The trailing-separator dance is
    /// the point: a bare `hasPrefix` says "/shared" is inside "/share", so
    /// containment is only ever tested at a segment boundary.
    public static func isWithin(root: String, candidate: String) -> Bool {
        if candidate == root { return true }
        let prefix = root.hasSuffix("/") ? root : root + "/"
        return candidate.hasPrefix(prefix)
    }

    /// Last segment of a normalised path, empty for the root.
    public static func basename(_ normalized: String) -> String {
        guard let cut = normalized.lastIndex(of: "/") else { return normalized }
        return String(normalized[normalized.index(after: cut)...])
    }

    /// Parent of a normalised path; the root is its own parent.
    public static func parent(_ normalized: String) -> String {
        guard let cut = normalized.lastIndex(of: "/") else { return "/" }
        if cut == normalized.startIndex { return "/" }
        return String(normalized[normalized.startIndex..<cut])
    }
}
