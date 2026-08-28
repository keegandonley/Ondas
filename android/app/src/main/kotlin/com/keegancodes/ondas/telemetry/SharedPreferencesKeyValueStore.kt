package com.keegancodes.ondas.telemetry

import android.content.Context
import android.content.SharedPreferences
import com.keegancodes.ondas.kit.telemetry.KeyValueStore

/**
 * Non-secret preferences, the counterpart of Swift reading `UserDefaults` through its
 * `KeyValueStore` protocol.
 *
 * Deliberately the app's DEFAULT preferences file rather than a private one: it is what
 * `UserDefaults.standard` corresponds to on Android, so the two platforms are configured the same
 * way and the keys can stay identical.
 *
 * The bearer key is NOT here — see [KeystoreSecretStore].
 */
public class SharedPreferencesKeyValueStore(context: Context) : KeyValueStore {

    private val preferences: SharedPreferences =
        context.applicationContext.getSharedPreferences(
            "${context.applicationContext.packageName}_preferences",
            Context.MODE_PRIVATE,
        )

    override fun string(key: String): String? = preferences.getString(key, null)

    override fun boolean(key: String): Boolean = preferences.getBoolean(key, false)

    override fun putString(key: String, value: String) {
        preferences.edit().putString(key, value).apply()
    }

    override fun putBoolean(key: String, value: Boolean) {
        preferences.edit().putBoolean(key, value).apply()
    }
}
