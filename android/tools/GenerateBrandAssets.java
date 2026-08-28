import java.awt.Color;
import java.awt.Graphics2D;
import java.awt.RenderingHints;
import java.awt.image.BufferedImage;
import java.io.File;
import javax.imageio.ImageIO;

/**
 * Derives every Android brand asset from the ONE iOS master,
 * {@code Ondas/Resources/Assets.xcassets/AppIcon.appiconset/OndasIcon.png}.
 *
 * Run from {@code android/}:
 *
 * <pre>java tools/GenerateBrandAssets.java ..</pre>
 *
 * The point is that nobody hand-cuts a lookalike. The iOS icon is the source of truth; if it
 * changes, this is re-run and the Android assets follow. Same approach as the sibling Scalene
 * port's generator.
 *
 * <h2>What it emits</h2>
 * <ul>
 *   <li>{@code app/src/main/res/drawable-nodpi/ic_launcher_foreground.png} — the wave mark alone,
 *       background keyed out, scaled into the adaptive-icon safe zone.</li>
 *   <li>{@code app/src/main/res/drawable-nodpi/ic_launcher_monochrome.png} — a flat silhouette for
 *       Android 13+ themed icons.</li>
 *   <li>{@code app/src/main/res/values/brand_colors.xml} — the icon background sampled from the
 *       master, so the adaptive background matches the artwork rather than being guessed.</li>
 * </ul>
 *
 * <h2>The safe zone is the whole reason this is not just a resize</h2>
 * An adaptive icon is a 108dp canvas of which only the central <b>66dp</b> is guaranteed visible —
 * launchers mask the rest into a circle, squircle or rounded square, and they also parallax the
 * layers. The iOS master is a full-bleed square whose mark already fills ~73% of it. Dropping that
 * straight in as the foreground puts the mark's edges under the mask, and a launcher using a
 * circular mask clips the wave crests. So the mark is measured, cropped to its true bounds, and
 * rescaled to sit inside the safe circle.
 */
public final class GenerateBrandAssets {

    /** Foreground canvas: 108dp at xxxhdpi (4x) = 432px. */
    private static final int CANVAS = 432;

    /**
     * Fraction of the 108dp canvas the mark may occupy. 66/108 is the guaranteed-visible safe
     * zone; 0.58 keeps a little air inside it so the mark does not touch the mask edge.
     */
    private static final double MARK_FRACTION = 0.58;

    /** How far a pixel must be from the sampled background colour to count as artwork. */
    private static final int BACKGROUND_TOLERANCE = 24;

    public static void main(String[] args) throws Exception {
        File repoRoot = new File(args.length > 0 ? args[0] : "..").getCanonicalFile();
        File master = new File(repoRoot,
                "Ondas/Resources/Assets.xcassets/AppIcon.appiconset/OndasIcon.png");
        if (!master.isFile()) {
            throw new IllegalStateException("iOS master not found at " + master);
        }

        BufferedImage source = ImageIO.read(master);
        System.out.printf("master: %dx%d%n", source.getWidth(), source.getHeight());

        int background = source.getRGB(4, 4);
        System.out.printf("sampled background: #%06x%n", background & 0xFFFFFF);

        Bounds bounds = markBounds(source, background);
        System.out.printf("mark bounds: x=%d..%d y=%d..%d (%dx%d)%n",
                bounds.minX, bounds.maxX, bounds.minY, bounds.maxY, bounds.width(), bounds.height());

        BufferedImage foreground = renderForeground(source, background, bounds);
        File resDir = new File(repoRoot, "android/app/src/main/res");
        write(foreground, new File(resDir, "drawable-nodpi/ic_launcher_foreground.png"));
        write(monochrome(foreground), new File(resDir, "drawable-nodpi/ic_launcher_monochrome.png"));
        writeColors(new File(resDir, "values/brand_colors.xml"), background);

        System.out.println("done");
    }

    /** The tightest box containing non-background pixels. */
    private static Bounds markBounds(BufferedImage image, int background) {
        int minX = image.getWidth();
        int minY = image.getHeight();
        int maxX = -1;
        int maxY = -1;
        for (int y = 0; y < image.getHeight(); y++) {
            for (int x = 0; x < image.getWidth(); x++) {
                if (isArtwork(image.getRGB(x, y), background)) {
                    if (x < minX) minX = x;
                    if (y < minY) minY = y;
                    if (x > maxX) maxX = x;
                    if (y > maxY) maxY = y;
                }
            }
        }
        if (maxX < 0) throw new IllegalStateException("no artwork found; is the master flat?");
        return new Bounds(minX, minY, maxX, maxY);
    }

    /**
     * Crops to the mark, keys out the background, and centres it in the safe zone.
     *
     * The alpha is a soft edge rather than a hard threshold: a hard cut leaves the mark's
     * antialiased boundary ringed with background-coloured pixels, which is glaring against a
     * launcher wallpaper that is not the near-white the artwork was drawn on.
     */
    private static BufferedImage renderForeground(BufferedImage source, int background, Bounds bounds) {
        int side = Math.max(bounds.width(), bounds.height());
        BufferedImage cropped = new BufferedImage(side, side, BufferedImage.TYPE_INT_ARGB);
        int offsetX = (side - bounds.width()) / 2;
        int offsetY = (side - bounds.height()) / 2;

        for (int y = 0; y < bounds.height(); y++) {
            for (int x = 0; x < bounds.width(); x++) {
                int rgb = source.getRGB(bounds.minX + x, bounds.minY + y);
                cropped.setRGB(offsetX + x, offsetY + y, withAlpha(rgb, background));
            }
        }

        int target = (int) Math.round(CANVAS * MARK_FRACTION);
        BufferedImage canvas = new BufferedImage(CANVAS, CANVAS, BufferedImage.TYPE_INT_ARGB);
        Graphics2D g = canvas.createGraphics();
        g.setRenderingHint(RenderingHints.KEY_INTERPOLATION, RenderingHints.VALUE_INTERPOLATION_BICUBIC);
        g.setRenderingHint(RenderingHints.KEY_RENDERING, RenderingHints.VALUE_RENDER_QUALITY);
        g.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON);
        int origin = (CANVAS - target) / 2;
        g.drawImage(cropped, origin, origin, target, target, null);
        g.dispose();
        return canvas;
    }

    /**
     * Alpha from distance to the background colour, so antialiased edges fade out instead of
     * leaving a halo.
     */
    private static int withAlpha(int rgb, int background) {
        int distance = colourDistance(rgb, background);
        int alpha;
        if (distance <= BACKGROUND_TOLERANCE) {
            alpha = 0;
        } else if (distance >= BACKGROUND_TOLERANCE * 3) {
            alpha = 255;
        } else {
            alpha = (int) Math.round(
                    255.0 * (distance - BACKGROUND_TOLERANCE) / (BACKGROUND_TOLERANCE * 2.0));
        }
        return (alpha << 24) | (rgb & 0xFFFFFF);
    }

    private static boolean isArtwork(int rgb, int background) {
        return colourDistance(rgb, background) > BACKGROUND_TOLERANCE;
    }

    private static int colourDistance(int a, int b) {
        int dr = ((a >> 16) & 0xFF) - ((b >> 16) & 0xFF);
        int dg = ((a >> 8) & 0xFF) - ((b >> 8) & 0xFF);
        int db = (a & 0xFF) - (b & 0xFF);
        return (int) Math.sqrt(dr * dr + dg * dg + db * db);
    }

    /** A flat silhouette. Themed icons are tinted by the launcher, so only the alpha survives. */
    private static BufferedImage monochrome(BufferedImage foreground) {
        BufferedImage out = new BufferedImage(CANVAS, CANVAS, BufferedImage.TYPE_INT_ARGB);
        for (int y = 0; y < CANVAS; y++) {
            for (int x = 0; x < CANVAS; x++) {
                int alpha = (foreground.getRGB(x, y) >>> 24);
                out.setRGB(x, y, (alpha << 24) | 0x000000);
            }
        }
        return out;
    }

    private static void writeColors(File file, int background) throws Exception {
        file.getParentFile().mkdirs();
        String hex = String.format("#%06X", background & 0xFFFFFF);
        String xml = """
                <?xml version="1.0" encoding="utf-8"?>
                <!--
                  GENERATED by tools/GenerateBrandAssets.java from the iOS icon master. Do not edit
                  by hand: re-run the generator instead, or the Android icon silently stops matching
                  the one iOS ships.
                -->
                <resources>
                    <color name="ic_launcher_background">%s</color>
                </resources>
                """.formatted(hex);
        java.nio.file.Files.writeString(file.toPath(), xml);
        System.out.println("wrote " + file);
    }

    private static void write(BufferedImage image, File file) throws Exception {
        file.getParentFile().mkdirs();
        ImageIO.write(image, "png", file);
        System.out.println("wrote " + file + " (" + image.getWidth() + "x" + image.getHeight() + ")");
    }

    private record Bounds(int minX, int minY, int maxX, int maxY) {
        int width() { return maxX - minX + 1; }
        int height() { return maxY - minY + 1; }
    }
}
