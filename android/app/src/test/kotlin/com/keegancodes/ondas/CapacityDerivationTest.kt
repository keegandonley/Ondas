package com.keegancodes.ondas

import com.keegancodes.ondas.kit.chat.TokenUsage
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Pins the A1 derivation.
 *
 * The capacity warning exists so compaction is offered while the summariser can still condense the
 * live segment in one pass. If the band fires later than the summariser's ceiling, the user is
 * offered a Continue button that cannot work — which is the exact dead end the band was introduced
 * to prevent, arrived at from the other side.
 *
 * That relationship is invisible in the code: it spans a constant in this module, a fraction in
 * `:ondaskit`, and a number that only exists because someone measured it on a phone. So it is
 * asserted rather than left as a comment for the next person to break.
 */
class CapacityDerivationTest {

    @Test
    fun `the warning band fires while the summariser can still succeed`() {
        val usableBudget = OndasGraph.MEASURED_TOKEN_LIMIT - OndasGraph.RESPONSE_TOKEN_RESERVE
        val warnsAt = usableBudget * TokenUsage.WARNING_FRACTION

        assertTrue(
            "the warning band fires at $warnsAt tokens but the summariser tops out at " +
                "${OndasGraph.MEASURED_SUMMARISER_CEILING_TOKENS}; compaction would be offered and " +
                "then fail. Re-derive RESPONSE_TOKEN_RESERVE or WARNING_FRACTION, do not raise " +
                "the ceiling constant without re-measuring on device.",
            warnsAt <= OndasGraph.MEASURED_SUMMARISER_CEILING_TOKENS,
        )
    }

    @Test
    fun `the reply reserve leaves a usable conversation budget`() {
        // A reserve so large that little context remains would make the chat fill immediately.
        val usableBudget = OndasGraph.MEASURED_TOKEN_LIMIT - OndasGraph.RESPONSE_TOKEN_RESERVE
        assertTrue(usableBudget > OndasGraph.MEASURED_TOKEN_LIMIT / 2)
    }
}
