import UIKit

// iOS 26 SDK: apps must use the scene life cycle. The window and the Capacitor view controller come from
// Main.storyboard, named in Info.plist (UIApplicationSceneManifest), so there is nothing else to set up here.
class SceneDelegate: UIResponder, UIWindowSceneDelegate {

    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard scene is UIWindowScene else { return }
    }
}
