import SwiftUI

/// An image thumbnail decoded off the main actor at a bounded pixel size, so list rows and the
/// gallery grid never load full-resolution bytes just to show a small preview. The caller sizes and
/// clips it; this view fills whatever frame it's given.
struct ThumbnailImage: View {
    let data: Data

    /// A cheap, stable identity for the bytes (e.g. the image's UUID). Drives re-decoding when a
    /// reused cell/row shows a different image — keyed on this rather than the `Data` itself so the
    /// per-update comparison never walks the whole JPEG.
    let identity: AnyHashable

    /// The largest edge, in pixels, to decode. Pass the on-screen point size times the screen scale.
    var maxPixelSize: CGFloat = 300

    @State private var image: UIImage?

    var body: some View {
        Group {
            if let image {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFill()
            } else {
                Rectangle()
                    .fill(Color(.tertiarySystemFill))
            }
        }
        // Re-decode only when the identity changes (e.g. a row is reused for another image).
        .task(id: identity) {
            // Clear first so a reused cell shows the placeholder — not the previous image — while
            // the new one decodes.
            image = nil
            let decoded = await Task.detached(priority: .userInitiated) {
                ImageThumbnail.decode(data, maxPixelSize: maxPixelSize)
            }.value
            // The detached decode isn't a child of this `.task`, so an identity change won't cancel
            // it. Bail if this task was cancelled while decoding, or a slow decode for the previous
            // image would clobber the newer one.
            guard !Task.isCancelled else { return }
            image = decoded
        }
    }
}
