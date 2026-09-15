using System.Globalization;
using System.Windows;
using System.Windows.Media;

namespace Revcode.Revit;

internal static class RibbonImages
{
    // Vector counterpart of web/src/assets/revcode-mark.svg, crisp at any display scale.
    public static ImageSource Mark()
    {
        var drawing = new DrawingGroup();
        using (var context = drawing.Open())
        {
            context.DrawRoundedRectangle(new SolidColorBrush(Color.FromRgb(37, 99, 235)), null,
                new Rect(0, 0, 32, 32), 7, 7);
            var text = new FormattedText("r/", CultureInfo.InvariantCulture, FlowDirection.LeftToRight,
                new Typeface(new FontFamily("Consolas"), FontStyles.Normal, FontWeights.Bold, FontStretches.Normal),
                15, Brushes.White, 1);
            context.DrawGeometry(Brushes.White, null, text.BuildGeometry(new Point((32 - text.Width) / 2, 21.5 - text.Baseline)));
        }
        var image = new DrawingImage(drawing);
        image.Freeze();
        return image;
    }

    public static ImageSource Action(string path)
    {
        var drawing = new DrawingGroup();
        using (var context = drawing.Open())
        {
            context.DrawRectangle(Brushes.Transparent, null, new Rect(0, 0, 24, 24));
            context.DrawGeometry(null, new Pen(new SolidColorBrush(Color.FromRgb(37, 99, 235)), 2)
                { StartLineCap = PenLineCap.Round, EndLineCap = PenLineCap.Round, LineJoin = PenLineJoin.Round }, Geometry.Parse(path));
        }
        var image = new DrawingImage(drawing);
        image.Freeze();
        return image;
    }
}
