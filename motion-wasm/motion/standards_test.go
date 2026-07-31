package motion

import (
	"math"
	"testing"
)

func TestIOSCardStandardProfiles(t *testing.T) {
	tests := []struct {
		standard Standard
		response float64
		damping  float64
	}{
		{StandardIOSCardGeometryOpen, 0.44, 1.00},
		{StandardIOSCardGeometryClose, 0.34, 1.00},
		{StandardIOSCardFlipOpen, 0.40, 0.96},
		{StandardIOSCardFlipClose, 0.38, 0.96},
		{StandardIOSCardContent, 0.32, 1.00},
		{StandardIOSCardScrim, 0.42, 1.00},
		{StandardStretchExpandOpen, 0.48, 1.00},
		{StandardStretchExpandClose, 0.48, 1.00},
	}
	for _, tt := range tests {
		profile, ok := ProfileForStandard(tt.standard)
		if !ok {
			t.Fatalf("standard %d missing", tt.standard)
		}
		if profile.Response != tt.response || profile.Damping != tt.damping {
			t.Errorf("standard %d = %+v, want response=%v damping=%v", tt.standard, profile, tt.response, tt.damping)
		}
	}
}

func TestConfigureStandardPreservesLiveState(t *testing.T) {
	var e Engine
	e.Init(1)
	e.Configure(0, 0.7, 1)
	e.AnimateTo(0, 100)
	for i := 0; i < 8; i++ {
		e.Tick(1.0 / 60)
	}
	x, v := e.Value(0), e.Velocity(0)
	if !e.ConfigureStandard(0, StandardIOSCardFlipOpen) {
		t.Fatal("ConfigureStandard returned false")
	}
	if e.Value(0) != x || e.Velocity(0) != v {
		t.Fatalf("standard reconfigure jumped: (%v,%v) -> (%v,%v)", x, v, e.Value(0), e.Velocity(0))
	}
}

func TestConfigureStandardRejectsUnknownWithoutMutation(t *testing.T) {
	var e Engine
	e.Init(1)
	e.Configure(0, 0.4, 1)
	beforeOmega, beforeZeta := e.slots[0].Omega, e.slots[0].Zeta
	if e.ConfigureStandard(0, Standard(9999)) {
		t.Fatal("unknown standard accepted")
	}
	if e.slots[0].Omega != beforeOmega || e.slots[0].Zeta != beforeZeta {
		t.Fatal("unknown standard mutated slot")
	}
	if e.ConfigureStandard(99, StandardIOSCardFlipOpen) {
		t.Fatal("invalid slot accepted")
	}
}

func TestIOSCardOpenFlipHasOnlySubDegreeOvershoot(t *testing.T) {
	var e Engine
	e.Init(2)
	if !e.ConfigureStandard(0, StandardIOSCardFlipOpen) || !e.ConfigureStandard(1, StandardIOSCardGeometryOpen) {
		t.Fatal("iOS card standards missing")
	}
	e.AnimateTo(0, -180)
	e.AnimateTo(1, 1)
	minRotation := 0.0
	maxGeometry := 0.0
	for i := 0; i < 600; i++ {
		e.Tick(1.0 / 240)
		minRotation = math.Min(minRotation, e.Value(0))
		maxGeometry = math.Max(maxGeometry, e.Value(1))
	}
	overshoot := math.Abs(minRotation) - 180
	if overshoot <= 0 || overshoot >= 1 {
		t.Fatalf("flip overshoot = %v degrees, want subtle (0,1)", overshoot)
	}
	if maxGeometry > 1.000001 {
		t.Fatalf("critical geometry overshot: %v", maxGeometry)
	}
}
