package com.keegancodes.ondas.kit.telemetry

import okhttp3.Dispatcher
import okhttp3.OkHttpClient
import java.util.concurrent.TimeUnit

/**
 * The single OkHttp client, mirroring Swift's use of `URLSession.shared`.
 *
 * Both values below are set EXPLICITLY even though Swift sets neither, because
 * **"neither side configures a timeout" does not mean parity — compare the DEFAULTS.** Swift
 * inherits `URLSession.shared`'s 60s; OkHttp's own defaults are 10s. On the sibling Scalene port
 * that exact omission broke a real screen against a slow endpoint, and it is invisible in review
 * because there is no line of code to look at.
 *
 * Neither is catchable by a MockWebServer test either — localhost answers instantly and never
 * saturates a dispatcher — which is why `HttpClientConfigTest` asserts them as CONFIGURATION
 * VALUES rather than trying to observe them as behaviour.
 */
public object HttpClientConfig {
    /** URLSession.shared's default, adopted deliberately rather than inherited from OkHttp's 10s. */
    public const val TIMEOUT_SECONDS: Long = 60

    /**
     * OkHttp's `Dispatcher.maxRequestsPerHost` defaults to 5 and counts REQUESTS, applying even
     * over a multiplexed HTTP/2 connection; `URLSession` caps CONNECTIONS, which h2 multiplexes.
     * Ondas only ever talks to one collector and does not fan out, so this is not load-bearing
     * here — it is set for consistency with the sibling ports, where it was.
     */
    public const val MAX_REQUESTS_PER_HOST: Int = 16

    public val shared: OkHttpClient by lazy {
        OkHttpClient.Builder()
            .connectTimeout(TIMEOUT_SECONDS, TimeUnit.SECONDS)
            .readTimeout(TIMEOUT_SECONDS, TimeUnit.SECONDS)
            .writeTimeout(TIMEOUT_SECONDS, TimeUnit.SECONDS)
            .dispatcher(Dispatcher().apply { maxRequestsPerHost = MAX_REQUESTS_PER_HOST })
            .build()
    }
}
