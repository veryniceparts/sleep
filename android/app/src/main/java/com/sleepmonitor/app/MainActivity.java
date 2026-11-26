package com.sleepmonitor.app;

import android.os.Bundle;

import androidx.activity.OnBackPressedCallback;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(SleepRecorderPlugin.class); // native background recorder
        super.onCreate(savedInstanceState);

        // Back button: let the app close its top screen (menu, settings, a night, night mode) first.
        // On the main screen, go to the background instead of closing, so a recording keeps running.
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                if (getBridge() == null || getBridge().getWebView() == null) { moveTaskToBack(true); return; }
                getBridge().getWebView().evaluateJavascript(
                        "(window.handleBack && window.handleBack()) ? 'closed' : 'none'",
                        (result) -> { if (!"\"closed\"".equals(result)) moveTaskToBack(true); });
            }
        });
    }
}
