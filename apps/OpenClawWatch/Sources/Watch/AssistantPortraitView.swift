import SwiftUI

#if os(watchOS)
import WatchKit
#elseif canImport(UIKit)
import UIKit
#endif

struct AssistantPortraitView: View {
    var status: WatchVoiceStatus
    var crop = AssistantPortraitCrop()

    var body: some View {
        ZStack(alignment: .topTrailing) {
            portrait
                .clipShape(Circle())
                .overlay(Circle().stroke(.white.opacity(0.18), lineWidth: 1))
                .accessibilityHidden(true)

            Circle()
                .fill(status.isListening ? Color.red : Color.black)
                .frame(width: 18, height: 18)
                .overlay(Circle().stroke(.white.opacity(0.7), lineWidth: 2))
                .padding(6)
                .accessibilityLabel(status.isListening ? "Listening" : "Not listening")
        }
        .aspectRatio(1, contentMode: .fit)
    }

    @ViewBuilder
    private var portrait: some View {
        if let image = LocalAssistantPortrait.load() {
            GeometryReader { proxy in
                Image(platformImage: image)
                    .resizable()
                    .scaledToFill()
                    .frame(width: proxy.size.width, height: proxy.size.height)
                    .offset(y: CGFloat((0.5 - crop.focusY) * 0.28 * proxy.size.height))
                    .clipped()
            }
        } else {
            ZStack {
                Circle().fill(Color.gray.opacity(0.28))
                Image(systemName: "waveform")
                    .font(.system(size: 48, weight: .semibold))
                    .foregroundStyle(.white)
            }
        }
    }
}

private enum LocalAssistantPortrait {
    static func load() -> PlatformImage? {
        for fileExtension in ["jpg", "jpeg", "png"] {
            if let url = Bundle.main.url(forResource: "AssistantPortrait", withExtension: fileExtension),
               let image = PlatformImage(contentsOfFile: url.path) {
                return image
            }
        }
        return nil
    }
}

#if os(watchOS) || canImport(UIKit)
private typealias PlatformImage = UIImage

private extension Image {
    init(platformImage: PlatformImage) {
        self.init(uiImage: platformImage)
    }
}
#endif

#Preview {
    VStack {
        AssistantPortraitView(status: .idle)
        AssistantPortraitView(status: .recording)
    }
}
