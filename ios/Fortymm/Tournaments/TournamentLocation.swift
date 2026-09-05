import Combine
import CoreLocation
import Foundation

/// Requests a single approximate location only after the player enables Near me.
@MainActor
final class TournamentLocation: NSObject, ObservableObject, @preconcurrency CLLocationManagerDelegate {
    @Published private(set) var enabled = false
    @Published var radiusMiles = 25
    @Published private(set) var locating = false
    @Published private(set) var message: String?
    @Published private var coordinate: CLLocationCoordinate2D?
    private let manager = CLLocationManager()
    private var timeout: Task<Void, Never>?
    var filter: TournamentNearMe? {
        guard enabled, let coordinate else { return nil }
        return TournamentNearMe(latitude: coordinate.latitude, longitude: coordinate.longitude, radiusMiles: radiusMiles)
    }
    override init() {
        super.init()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyKilometer
    }
    func setEnabled(_ value: Bool) {
        timeout?.cancel()
        enabled = value
        coordinate = nil
        message = nil
        locating = value
        guard value else { manager.stopUpdatingLocation(); return }
        timeout = Task { [weak self] in
            try? await Task.sleep(for: .seconds(20))
            guard !Task.isCancelled else { return }
            self?.fail()
        }
        switch manager.authorizationStatus {
        case .notDetermined: manager.requestWhenInUseAuthorization()
        case .authorizedAlways, .authorizedWhenInUse: manager.requestLocation()
        default: fail()
        }
    }
    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        guard enabled else { return }
        switch manager.authorizationStatus {
        case .authorizedAlways, .authorizedWhenInUse: manager.requestLocation()
        case .denied, .restricted: fail()
        default: break
        }
    }
    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard enabled, let latest = locations.last, latest.horizontalAccuracy >= 0,
              CLLocationCoordinate2DIsValid(latest.coordinate) else { return }
        timeout?.cancel()
        coordinate = latest.coordinate
        locating = false
    }
    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) { if enabled { fail() } }
    private func fail() {
        timeout?.cancel()
        enabled = false
        locating = false
        coordinate = nil
        message = "Location unavailable. Showing every tournament. Check location access in Settings and try again."
    }
}
