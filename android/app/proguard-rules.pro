# The JavaScript bridge is reached by name from the page, so it must survive
# any future shrinking.
-keepclassmembers class com.watchkeeper.MainActivity$Bridge {
    public *;
}
-keepattributes JavascriptInterface
