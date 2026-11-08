import SwiftUI
import UIKit

/// The desktop reader's palette: "paper reader" in light mode, "warm minimal" in dark.
enum Theme {
    private static func dynamic(light: UIColor, dark: UIColor) -> UIColor {
        UIColor { $0.userInterfaceStyle == .dark ? dark : light }
    }

    private static func rgb(_ r: CGFloat, _ g: CGFloat, _ b: CGFloat, _ a: CGFloat = 1) -> UIColor {
        UIColor(red: r / 255, green: g / 255, blue: b / 255, alpha: a)
    }

    static let backgroundUI = dynamic(light: rgb(250, 249, 246), dark: rgb(33, 29, 26))
    static let surfaceUI = dynamic(light: .white, dark: rgb(42, 36, 33))
    static let textUI = dynamic(light: rgb(35, 34, 31), dark: rgb(221, 208, 194))
    /// The desktop reader uses the same 0.55 opacity for text awaiting audio.
    static let pendingTextUI = dynamic(light: rgb(35, 34, 31, 0.55), dark: rgb(221, 208, 194, 0.55))
    static let accentUI = dynamic(light: rgb(194, 90, 50), dark: rgb(210, 105, 63))
    static let wordBackgroundUI = dynamic(light: rgb(255, 217, 168), dark: rgb(210, 105, 63))
    static let wordTextUI = dynamic(light: rgb(90, 68, 22), dark: .white)
    static let sentenceBackgroundUI = dynamic(light: rgb(210, 105, 63, 0.12), dark: rgb(210, 105, 63, 0.17))

    static let background = Color(backgroundUI)
    static let surface = Color(surfaceUI)
    static let text = Color(textUI)
    static let accent = Color(accentUI)
}
