package motion

// Standard identifies a stable, product-level motion profile. Unlike a raw
// response/damping pair, a Standard is an ABI contract: JavaScript call sites
// can request an interaction by name while the Go engine owns its tuning.
type Standard int32

const (
	StandardIOSCardGeometryOpen Standard = iota + 1
	StandardIOSCardGeometryClose
	StandardIOSCardFlipOpen
	StandardIOSCardFlipClose
	StandardIOSCardContent
	StandardIOSCardScrim
	// Bottom-anchored vertical fill (mobile terminal fullscreen).
	// Open/close share identical critical damping so reverse is symmetric.
	StandardStretchExpandOpen
	StandardStretchExpandClose
)

// StandardProfile is the Apple-style spring parameter pair used by a
// Standard. Response is in seconds; Damping is a damping ratio.
type StandardProfile struct {
	Response float64
	Damping  float64
}

// ProfileForStandard returns the canonical physics for a standard motion.
// Geometry is critically damped so the card lands without edge wobble; the
// opening half-turn gets only a sub-degree soft settle. Closing is faster and
// nearly critical, matching iOS's asymmetric open/close cadence.
func ProfileForStandard(standard Standard) (StandardProfile, bool) {
	switch standard {
	case StandardIOSCardGeometryOpen:
		return StandardProfile{Response: 0.44, Damping: 1.00}, true
	case StandardIOSCardGeometryClose:
		return StandardProfile{Response: 0.34, Damping: 1.00}, true
	case StandardIOSCardFlipOpen:
		return StandardProfile{Response: 0.40, Damping: 0.96}, true
	case StandardIOSCardFlipClose:
		return StandardProfile{Response: 0.38, Damping: 0.96}, true
	case StandardIOSCardContent:
		return StandardProfile{Response: 0.32, Damping: 1.00}, true
	case StandardIOSCardScrim:
		return StandardProfile{Response: 0.42, Damping: 1.00}, true
	case StandardStretchExpandOpen:
		// ~0.6s visual fill, critically damped — matches ref easeInOutQuart cadence
		// without CSS. Same profile on close for interruptible reverse symmetry.
		return StandardProfile{Response: 0.48, Damping: 1.00}, true
	case StandardStretchExpandClose:
		return StandardProfile{Response: 0.48, Damping: 1.00}, true
	default:
		return StandardProfile{}, false
	}
}

// ConfigureStandard applies a stable standard profile while preserving the
// slot's live value and velocity. Unknown standards never mutate the slot.
func (e *Engine) ConfigureStandard(id int, standard Standard) bool {
	if !e.ok(id) {
		return false
	}
	profile, ok := ProfileForStandard(standard)
	if !ok {
		return false
	}
	e.slots[id].Configure(profile.Response, profile.Damping)
	return true
}

func (e *Engine) StandardProfile(standard Standard) (StandardProfile, bool) {
	return ProfileForStandard(standard)
}
