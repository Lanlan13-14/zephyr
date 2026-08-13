package one.zephyr.mobile.ui.island

/**
 * Island layout arithmetic, deliberately free of Compose types.
 *
 * DEVELOPMENT.md 6.1.1 states two rules that pull against each other: the four items split the
 * remaining space evenly, *and* the selected pill is sized by its content. Resolving that needs real
 * arithmetic with a documented tie-breaker, and an accessibility floor that must hold on a 320dp
 * screen as well as a tablet. Keeping it as plain functions means the floor can be unit-tested
 * instead of eyeballed in a screenshot.
 *
 * All values are in dp as Float; the composable converts once at the boundary.
 */
object IslandGeometry {

    const val DESTINATION_COUNT: Int = 4

    /** Outer capsule width: 88% of the viewport, capped at the frozen phone width. */
    fun outerWidth(screenWidthDp: Float, widthFraction: Float, maxWidthDp: Float): Float =
        minOf(screenWidthDp * widthFraction, maxWidthDp).coerceAtLeast(0f)

    /** Width available to the item row after the inner padding on both sides. */
    fun innerWidth(outerWidthDp: Float, innerPaddingDp: Float): Float =
        (outerWidthDp - innerPaddingDp * 2f).coerceAtLeast(0f)

    /** Each destination gets an equal slot; the pill is drawn inside its own slot. */
    fun slotWidth(innerWidthDp: Float, count: Int = DESTINATION_COUNT): Float =
        if (count <= 0) 0f else innerWidthDp / count

    /**
     * Content width the selected pill wants: icon + gap + label + padding on both sides.
     *
     * @param labelWidthDp measured single-line label width, 0 when no label is shown.
     */
    fun desiredPillWidth(
        labelWidthDp: Float,
        iconSizeDp: Float,
        iconLabelGapDp: Float,
        horizontalPaddingDp: Float,
    ): Float {
        val label = if (labelWidthDp <= 0f) 0f else iconLabelGapDp + labelWidthDp
        return horizontalPaddingDp * 2f + iconSizeDp + label
    }

    /**
     * Whether the label may be shown at all.
     *
     * The pill must fit inside its own slot, because a pill that overflows would push a neighbour's
     * hit area below the 48dp floor. When it does not fit the island degrades to four equal
     * icon-only items, which the spec permits as long as the accessibility label survives.
     */
    fun labelFits(
        slotWidthDp: Float,
        labelWidthDp: Float,
        iconSizeDp: Float,
        iconLabelGapDp: Float,
        horizontalPaddingDp: Float,
    ): Boolean {
        if (labelWidthDp <= 0f) return false
        val desired = desiredPillWidth(labelWidthDp, iconSizeDp, iconLabelGapDp, horizontalPaddingDp)
        return desired <= slotWidthDp
    }

    /** Final pill width, clamped to its slot so neighbours keep their hit area. */
    fun pillWidth(
        slotWidthDp: Float,
        labelWidthDp: Float,
        iconSizeDp: Float,
        iconLabelGapDp: Float,
        horizontalPaddingDp: Float,
    ): Float {
        val withLabel = labelFits(slotWidthDp, labelWidthDp, iconSizeDp, iconLabelGapDp, horizontalPaddingDp)
        val desired = desiredPillWidth(
            labelWidthDp = if (withLabel) labelWidthDp else 0f,
            iconSizeDp = iconSizeDp,
            iconLabelGapDp = iconLabelGapDp,
            horizontalPaddingDp = horizontalPaddingDp,
        )
        return minOf(desired, slotWidthDp)
    }

    /** Left edge of a slot, relative to the inner row. */
    fun slotLeft(index: Int, slotWidthDp: Float): Float = index * slotWidthDp

    /** Left edge of the pill so it is centred inside its slot. */
    fun pillLeft(index: Int, slotWidthDp: Float, pillWidthDp: Float): Float =
        slotLeft(index, slotWidthDp) + (slotWidthDp - pillWidthDp) / 2f

    /** Corner radius of the outer capsule: exactly half its height. */
    fun outerCornerRadius(outerHeightDp: Float): Float = outerHeightDp / 2f

    /** The prototype places the island 18dp above the safe-area edge. */
    fun bottomGap(safeAreaBottomDp: Float, fixedGapDp: Float): Float =
        safeAreaBottomDp + fixedGapDp

    /**
     * Bottom content inset for scrollable pages.
     *
     * Visible island height + gap + safe area, so the last list row can scroll clear of the island
     * rather than sitting permanently underneath it.
     */
    fun contentBottomInset(
        outerHeightDp: Float,
        contentGapDp: Float,
        safeAreaBottomDp: Float,
        fixedGapDp: Float,
    ): Float = outerHeightDp + contentGapDp + bottomGap(safeAreaBottomDp, fixedGapDp)

    /** True when every slot still clears the platform touch-target floor. */
    fun meetsTouchTargetFloor(slotWidthDp: Float, minTouchTargetDp: Float): Boolean =
        slotWidthDp >= minTouchTargetDp
}
