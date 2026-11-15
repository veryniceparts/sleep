package com.sleepmonitor.app;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(SleepRecorderPlugin.class); // native background recorder
        super.onCreate(savedInstanceState);
    }
}
