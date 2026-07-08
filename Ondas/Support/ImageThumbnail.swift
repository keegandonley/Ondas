import ImageIO
import UIKit
import UniformTypeIdentifiers

/// Decodes a downsampled thumbnail from JPEG data without loading the full-resolution image into
/// memory. Used by list rows and the gallery grid, where many images are on screen at once and a
/// full decode per cell would be wasteful.
enum ImageThumbnail {
    /// Produces a `UIImage` whose largest edge is at most `maxPixelSize` pixels. Returns nil if the
    /// data isn't a decodable image. Safe to call off the main actor.
    static func decode(_ data: Data, maxPixelSize: CGFloat) -> UIImage? {
        let sourceOptions = [kCGImageSourceShouldCache: false] as CFDictionary
        guard let source = CGImageSourceCreateWithData(data as CFData, sourceOptions) else {
            return nil
        }
        let options = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceShouldCacheImmediately: true,
            kCGImageSourceThumbnailMaxPixelSize: max(1, maxPixelSize),
        ] as CFDictionary
        guard let cgImage = CGImageSourceCreateThumbnailAtIndex(source, 0, options) else {
            return nil
        }
        return UIImage(cgImage: cgImage)
    }
}
