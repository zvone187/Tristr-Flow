import SwiftUI
import UIKit

/// The text being read. A UITextView rather than SwiftUI Text: long text scrolls
/// smoothly, a tap resolves to an exact character (for tap-to-seek), and words
/// can still be long-pressed and copied, as on the desktop.
struct ReaderTextView: UIViewRepresentable {
    let timeline: Timeline
    let currentWord: Int?
    let generatedWords: Int
    let followToken: Int
    let fontSize: CGFloat
    let onTapWord: (Int) -> Void

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> UITextView {
        let view = UITextView()
        view.isEditable = false
        view.isSelectable = true
        view.backgroundColor = .clear
        view.textContainerInset = UIEdgeInsets(top: 20, left: 16, bottom: 48, right: 16)
        view.alwaysBounceVertical = true
        view.delegate = context.coordinator
        view.accessibilityIdentifier = "readerText"

        let tap = UITapGestureRecognizer(target: context.coordinator, action: #selector(Coordinator.tapped(_:)))
        tap.delegate = context.coordinator
        view.addGestureRecognizer(tap)

        context.coordinator.textView = view
        return view
    }

    func updateUIView(_ view: UITextView, context: Context) {
        let c = context.coordinator
        c.onTapWord = onTapWord
        if c.timeline !== timeline || c.fontSize != fontSize {
            c.render(timeline, fontSize: fontSize)
        }
        c.showGenerated(upTo: generatedWords)
        c.highlight(currentWord)
        if c.followToken != followToken {
            c.followToken = followToken
            c.resumeFollowing()
        }
    }

    final class Coordinator: NSObject, UITextViewDelegate, UIGestureRecognizerDelegate {
        weak var textView: UITextView?
        var onTapWord: ((Int) -> Void)?
        var followToken = 0
        private(set) var timeline: Timeline?
        private(set) var fontSize: CGFloat = 0

        private var shownGenerated = 0
        private var word: Int?
        private var sentence: Int?
        /// Auto-scroll keeps the spoken word on screen until the user scrolls away;
        /// it picks up again four seconds after they stop (as on the desktop).
        private var following = true
        private var resumeWork: DispatchWorkItem?

        func render(_ timeline: Timeline, fontSize: CGFloat) {
            guard let view = textView else { return }
            self.timeline = timeline
            self.fontSize = fontSize
            let paragraph = NSMutableParagraphStyle()
            paragraph.lineSpacing = fontSize * 0.42
            paragraph.paragraphSpacing = fontSize * 0.6
            view.attributedText = NSAttributedString(string: timeline.text, attributes: [
                .font: UIFont.systemFont(ofSize: fontSize),
                .foregroundColor: Theme.pendingTextUI,
                .paragraphStyle: paragraph,
            ])
            shownGenerated = 0
            word = nil
            sentence = nil
            following = true
            view.setContentOffset(CGPoint(x: 0, y: -view.adjustedContentInset.top), animated: false)
        }

        /// Lifts words to full colour as their audio arrives.
        func showGenerated(upTo count: Int) {
            guard let view = textView, let timeline, !timeline.words.isEmpty else { return }
            let count = min(count, timeline.words.count)
            guard count > shownGenerated else { return }
            let from = timeline.words[shownGenerated].range.location
            let to = NSMaxRange(timeline.words[count - 1].range)
            let storage = view.textStorage
            storage.beginEditing()
            storage.addAttribute(.foregroundColor, value: Theme.textUI, range: NSRange(location: from, length: to - from))
            if let w = word, w < count, w >= shownGenerated {
                storage.addAttribute(.foregroundColor, value: Theme.wordTextUI, range: timeline.words[w].range)
            }
            storage.endEditing()
            shownGenerated = count
        }

        func highlight(_ newWord: Int?) {
            guard newWord != word, let view = textView, let timeline else { return }
            let storage = view.textStorage
            storage.beginEditing()
            if let s = sentence { storage.removeAttribute(.backgroundColor, range: timeline.sentences[s]) }
            if let w = word {
                storage.removeAttribute(.backgroundColor, range: timeline.words[w].range)
                storage.addAttribute(.foregroundColor, value: w < shownGenerated ? Theme.textUI : Theme.pendingTextUI,
                                     range: timeline.words[w].range)
            }
            word = newWord
            sentence = newWord.map { timeline.words[$0].sentence }
            if let s = sentence {
                storage.addAttribute(.backgroundColor, value: Theme.sentenceBackgroundUI, range: timeline.sentences[s])
            }
            if let w = newWord {
                storage.addAttribute(.backgroundColor, value: Theme.wordBackgroundUI, range: timeline.words[w].range)
                storage.addAttribute(.foregroundColor, value: Theme.wordTextUI, range: timeline.words[w].range)
            }
            storage.endEditing()
            if let w = newWord { follow(w) }
        }

        // MARK: Following the voice

        private func follow(_ w: Int) {
            guard following, let view = textView, let timeline,
                  let start = view.position(from: view.beginningOfDocument, offset: timeline.words[w].range.location),
                  let end = view.position(from: start, offset: timeline.words[w].range.length),
                  let range = view.textRange(from: start, to: end) else { return }
            let rect = view.firstRect(for: range)
            guard !rect.isNull, !rect.isInfinite, rect.height > 0 else { return }

            let insets = view.adjustedContentInset
            let visible = view.bounds.inset(by: insets)
            let margin = visible.height * 0.2
            // Already in the comfortable middle band: leave the scroll alone.
            if rect.minY >= visible.minY + margin, rect.maxY <= visible.maxY - margin { return }
            let lowest = -insets.top
            let highest = max(lowest, view.contentSize.height - view.bounds.height + insets.bottom)
            let target = min(max(rect.midY - insets.top - visible.height / 2, lowest), highest)
            view.setContentOffset(CGPoint(x: view.contentOffset.x, y: target), animated: true)
        }

        func resumeFollowing() {
            resumeWork?.cancel()
            following = true
            if let w = word { follow(w) }
        }

        func scrollViewWillBeginDragging(_ scrollView: UIScrollView) {
            resumeWork?.cancel()
            following = false
        }

        func scrollViewDidEndDragging(_ scrollView: UIScrollView, willDecelerate decelerate: Bool) {
            if !decelerate { scheduleResume() }
        }

        func scrollViewDidEndDecelerating(_ scrollView: UIScrollView) {
            scheduleResume()
        }

        private func scheduleResume() {
            resumeWork?.cancel()
            let work = DispatchWorkItem { [weak self] in self?.following = true }
            resumeWork = work
            DispatchQueue.main.asyncAfter(deadline: .now() + 4, execute: work)
        }

        // MARK: Tap to seek

        @objc func tapped(_ gesture: UITapGestureRecognizer) {
            guard gesture.state == .ended, let view = textView, let timeline else { return }
            // A tap that dismisses a selection keeps the current playback position.
            guard view.selectedRange.length == 0 else { return }
            let point = gesture.location(in: view)
            guard let hit = view.characterRange(at: point) else { return } // empty space below the text
            let index = view.offset(from: view.beginningOfDocument, to: hit.start)
            guard let w = timeline.nearestWord(toUTF16: index) else { return }
            onTapWord?(w)
        }

        func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer,
                               shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool { true }
    }
}
