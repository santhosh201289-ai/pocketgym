package ch.duartesantos.pocketgym;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.text.method.LinkMovementMethod;
import android.util.TypedValue;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

/**
 * What Health Connect shows when someone asks why Pocket Gym wants their health data: from its
 * permission screen ("privacy policy") and from its app list. Android 14 and up reach it through
 * the VIEW_PERMISSION_USAGE alias in AndroidManifest.xml, Android 13 and lower through
 * androidx.health.ACTION_SHOW_PERMISSIONS_RATIONALE.
 *
 * Its own small native screen rather than the app: MainActivity is singleTask and loads the whole
 * web app, and pointing Health Connect at it left a blank screen over the permission flow. This one
 * opens instantly, says what is read and written and why, and closes back to where it came from.
 */
public class HealthPermissionsActivity extends Activity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        int pad = dp(24);

        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setPadding(pad, pad, pad, pad);

        TextView title = new TextView(this);
        title.setText("Pocket Gym and your health data");
        title.setTextSize(TypedValue.COMPLEX_UNIT_SP, 22);
        title.setPadding(0, 0, 0, dp(16));
        box.addView(title);

        TextView body = new TextView(this);
        body.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16);
        body.setLineSpacing(0, 1.2f);
        body.setText(
                "Reading (Settings → Data & backup → Import from Health Connect)\n"
                + "Steps, distance, active calories, resting heart rate, heart rate during workouts, sleep, "
                + "and the runs, rides, walks and swims other apps and watches record. Pocket Gym shows them "
                + "on Home and in Stats, and saves them in your Pocket Gym profile so they reach your other "
                + "devices through your Pocket Gym server.\n\n"
                + "Writing (Settings → Data & backup → Write to Health Connect)\n"
                + "Your finished workouts and weigh-ins, so other health apps can see them.\n\n"
                + "Each side is off until you turn it on, and you can take any permission back here in "
                + "Health Connect at any time. Data already imported stays in your profile until you delete "
                + "it in Pocket Gym. Pocket Gym does not sell or share your health data, and it is not used "
                + "for advertising.");
        body.setMovementMethod(LinkMovementMethod.getInstance());
        box.addView(body);

        Button open = new Button(this);
        open.setText("Open Pocket Gym");
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.topMargin = dp(24);
        open.setLayoutParams(lp);
        open.setOnClickListener(v -> {
            Intent i = new Intent(this, MainActivity.class);
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
            startActivity(i);
            finish();
        });
        box.addView(open);

        Button web = new Button(this);
        web.setText("pocketgym.cloud");
        web.setOnClickListener(v -> startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse("https://pocketgym.cloud"))));
        box.addView(web);

        ScrollView scroll = new ScrollView(this);
        scroll.addView(box);
        setContentView(scroll);
    }

    private int dp(int v) {
        return Math.round(TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, getResources().getDisplayMetrics()));
    }
}
