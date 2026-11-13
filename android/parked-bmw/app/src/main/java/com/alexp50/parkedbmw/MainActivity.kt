package com.alexp50.parkedbmw

import android.content.Context
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.core.view.WindowCompat
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URLEncoder
import java.net.URL
import java.time.Duration
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

data class Tyres(val fl: Double?, val fr: Double?, val rl: Double?, val rr: Double?)
data class ClimateState(
    val on: Boolean?, val frontDefrost: Boolean?, val rearDefrost: Boolean?,
    val preconditioning: Boolean?, val preconditioningMode: String?, val operatingMode: String?, val engineRunning: Boolean?,
    val driverTarget: Double?, val passengerTarget: Double?,
    val fanDriver: Int?, val fanPassenger: Int?, val fanRear: Int?,
    val autoDriver: Boolean?, val autoPassenger: Boolean?, val autoRearLeft: Boolean?, val autoRearRight: Boolean?,
    val sync: Boolean?, val recirculation: String?,
    val driverHeat: Int?, val passengerHeat: Int?, val rearLeftHeat: Int?, val rearRightHeat: Int?,
    val driverVent: Int?, val passengerVent: Int?, val rearLeftVent: Int?, val rearRightVent: Int?
)
data class WarmupState(val active:Boolean, val progress:Int?, val minutes:Double?, val distance:Double?, val safeRpm:Int?, val completedAt:Instant?)
data class TripState(val id:String, val startedAt:Instant?, val endedAt:Instant?, val distanceKm:Double?, val durationSeconds:Int?, val topSpeedKmh:Double?, val fuelLitres:Double?)
data class HealthState(val coolant:Double?, val oilTemperature:Double?, val oilLevel:String?, val rangeKm:Double?, val tankLitres:Double?)
data class ServiceItem(val name:String, val distance:String?, val date:String?)
data class AssistantState(
    val warmup:WarmupState?, val currentTrip:TripState?, val recentTrips:List<TripState>, val health:HealthState?,
    val services:List<ServiceItem>, val checkControlActive:Int, val bridgeVersion:String?, val providersReady:Int?, val providersTotal:Int?
)
data class Snapshot(
    val received: Instant, val sampled: Instant?, val awake: Boolean,
    val inside: Double?, val insideSampled: Instant?, val insideSource: String?,
    val outside: Double?, val battery: Double?, val voltage: Double?, val speed: Double?,
    val tyres: Tyres?, val climate: ClimateState?, val assistant: AssistantState?
)
data class CommandResult(val id: String, val status: String, val result: String?)

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WindowCompat.setDecorFitsSystemWindows(window, true)
        setContent { ParkedBmwApp(this) }
    }
}

private val Bg = Color(0xFF071018)
private val Panel = Color(0xFF10212D)
private val Cyan = Color(0xFF35D6D0)
private val Blue = Color(0xFF4AAFFF)
private val Green = Color(0xFF32E875)
private val Amber = Color(0xFFFFB52E)
private val Red = Color(0xFFFF3658)

@Composable
fun ParkedBmwApp(context: Context) {
    val prefs = remember { context.getSharedPreferences("connection", Context.MODE_PRIVATE) }
    var endpoint by remember { mutableStateOf(prefs.getString("endpoint", "") ?: "") }
    var token by remember { mutableStateOf(prefs.getString("token", "") ?: "") }
    var commandToken by remember { mutableStateOf(prefs.getString("commandToken", "") ?: "") }
    var carId by remember { mutableStateOf(prefs.getString("carId", "my-g12") ?: "my-g12") }
    var editing by remember { mutableStateOf(endpoint.isBlank() || token.isBlank()) }
    var snapshot by remember { mutableStateOf<Snapshot?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var refreshing by remember { mutableStateOf(false) }
    var refreshKey by remember { mutableIntStateOf(0) }
    var commandState by remember { mutableStateOf("Ready") }
    var page by remember { mutableStateOf("OVERVIEW") }
    val scope = rememberCoroutineScope()

    LaunchedEffect(endpoint, token, carId, refreshKey) {
        if (endpoint.isBlank() || token.isBlank() || carId.isBlank()) return@LaunchedEffect
        do {
            refreshing = true
            try { snapshot = fetchSnapshot(endpoint, token, carId); error = null }
            catch (e: Exception) { error = e.message ?: "Connection failed" }
            refreshing = false
            delay(5_000)
        } while (true)
    }

    MaterialTheme(colorScheme = darkColorScheme(background=Bg, surface=Panel, primary=Cyan, secondary=Blue)) {
        Box(Modifier.fillMaxSize().background(Brush.verticalGradient(listOf(Color(0xFF0B1B27), Bg)))) {
            Column(Modifier.fillMaxSize().safeDrawingPadding().verticalScroll(rememberScrollState()).padding(20.dp), verticalArrangement=Arrangement.spacedBy(14.dp)) {
                Row(Modifier.fillMaxWidth(), verticalAlignment=Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text("PARKED BMW", color=Color.White, fontSize=28.sp, fontWeight=FontWeight.Black)
                        Text("Remote telemetry and climate control", color=Cyan, fontSize=13.sp)
                    }
                    TextButton(onClick={ editing = !editing }) { Text(if (editing) "CLOSE" else "SETUP") }
                }
                if (editing) ConnectionCard(endpoint, token, commandToken, carId,
                    onEndpoint={endpoint=it}, onToken={token=it}, onCommandToken={commandToken=it}, onCar={carId=it}, onSave={
                        prefs.edit().putString("endpoint",endpoint.trimEnd('/')).putString("token",token).putString("commandToken",commandToken).putString("carId",carId).apply()
                        editing=false; refreshKey++
                    })
                FreshnessCard(snapshot, error, refreshing) { refreshKey++ }
                Row(Modifier.fillMaxWidth(), horizontalArrangement=Arrangement.spacedBy(8.dp)) {
                    listOf("OVERVIEW", "ASSISTANT", "CLIMATE").forEach { destination ->
                        if (page == destination) Button(onClick={ page=destination }, modifier=Modifier.weight(1f)) { Text(destination) }
                        else OutlinedButton(onClick={ page=destination }, modifier=Modifier.weight(1f)) { Text(destination) }
                    }
                }
                when (page) {
                    "ASSISTANT" -> AssistantPanel(snapshot?.assistant)
                    "CLIMATE" -> ClimateControls(enabled=isLive(snapshot) && commandToken.isNotBlank(), state=commandState, climate=snapshot?.climate) { command ->
                        scope.launch {
                            commandState = "Sending…"
                            try {
                                val result = sendCommand(endpoint, commandToken, carId, command)
                                commandState = when (result.status) {
                                    "accepted" -> result.result ?: "Accepted by the car"
                                    "rejected", "error", "expired" -> result.result ?: result.status
                                    else -> "Queued for the car"
                                }
                                if (result.status == "accepted") { delay(1_200); refreshKey++ }
                            } catch (e: Exception) { commandState = e.message ?: "Command failed" }
                        }
                    }
                    else -> {
                        HeroTemperature(snapshot)
                        Row(Modifier.fillMaxWidth(), horizontalArrangement=Arrangement.spacedBy(12.dp)) {
                            MetricCard("OUTSIDE", temp(snapshot?.outside), "°C", Blue, Modifier.weight(1f))
                            MetricCard("12 V CHARGE", value(snapshot?.battery,0), "%", batteryColor(snapshot?.battery), Modifier.weight(1f))
                        }
                        Row(Modifier.fillMaxWidth(), horizontalArrangement=Arrangement.spacedBy(12.dp)) {
                            MetricCard("BATTERY VOLTAGE", value(snapshot?.voltage,2), "V", voltageColor(snapshot?.voltage), Modifier.weight(1f))
                            MetricCard("VEHICLE SPEED", value(snapshot?.speed,1), "km/h", Cyan, Modifier.weight(1f))
                        }
                        TyreCard(snapshot?.tyres)
                    }
                }
                Text("The MGU and LTE modem switch off when the car sleeps. Webasto can continue independently, but live controls require the MGU to be awake. Stale cabin readings are never presented as current.", color=Color(0xFF8EA5B5), fontSize=13.sp)
            }
        }
    }
}

@Composable private fun AssistantPanel(assistant:AssistantState?) {
    if (assistant == null) {
        Card(colors=CardDefaults.cardColors(containerColor=Panel), shape=RoundedCornerShape(18.dp)) {
            Column(Modifier.fillMaxWidth().padding(18.dp), verticalArrangement=Arrangement.spacedBy(6.dp)) {
                Text("BMW ASSISTANT", color=Cyan, fontWeight=FontWeight.Bold)
                Text("Waiting for the updated telemetry bridge", color=Color(0xFFAFC1CC))
            }
        }
        return
    }
    val warm=assistant.warmup
    Card(colors=CardDefaults.cardColors(containerColor=Panel), shape=RoundedCornerShape(18.dp)) {
        Column(Modifier.fillMaxWidth().padding(18.dp), verticalArrangement=Arrangement.spacedBy(10.dp)) {
            Text("ENGINE WARM-UP", color=Cyan, fontWeight=FontWeight.Bold)
            Text(when {
                warm?.active == true -> "WARMING UP"
                warm?.completedAt != null -> "OPERATING TEMPERATURE REACHED"
                else -> "ENGINE OFF"
            }, color=if(warm?.active == true) Amber else Green, fontSize=21.sp, fontWeight=FontWeight.Black)
            LinearProgressIndicator(progress={((warm?.progress ?: 0)/100f).coerceIn(0f,1f)}, modifier=Modifier.fillMaxWidth().height(10.dp), color=Cyan, trackColor=Color(0xFF263946))
            Row(Modifier.fillMaxWidth(), horizontalArrangement=Arrangement.spacedBy(10.dp)) {
                MetricCard("PROGRESS", (warm?.progress?.toString() ?: "--"), "%", Cyan, Modifier.weight(1f))
                MetricCard("TIME LEFT", warm?.minutes?.let{String.format("%.0f",it)} ?: "--", "min", Amber, Modifier.weight(1f))
                MetricCard("DISTANCE", warm?.distance?.let{String.format("%.1f",it)} ?: "--", "km", Blue, Modifier.weight(1f))
            }
            Text("Estimated safe limit ${warm?.safeRpm ?: 2000} rpm. Estimates learn from the current warm-up rate.", color=Color(0xFF8EA5B5), fontSize=12.sp)
        }
    }
    assistant.health?.let { health ->
        Card(colors=CardDefaults.cardColors(containerColor=Panel), shape=RoundedCornerShape(18.dp)) {
            Column(Modifier.fillMaxWidth().padding(18.dp), verticalArrangement=Arrangement.spacedBy(10.dp)) {
                Text("VEHICLE HEALTH", color=Cyan, fontWeight=FontWeight.Bold)
                Row(Modifier.fillMaxWidth(), horizontalArrangement=Arrangement.spacedBy(10.dp)) {
                    MetricCard("COOLANT", value(health.coolant,0), "°C", if((health.coolant?:0.0)>=80) Green else Cyan, Modifier.weight(1f))
                    MetricCard("OIL TEMP", value(health.oilTemperature,0), "°C", if((health.oilTemperature?:0.0)>=70) Green else Cyan, Modifier.weight(1f))
                }
                Row(Modifier.fillMaxWidth(), horizontalArrangement=Arrangement.spacedBy(10.dp)) {
                    MetricCard("RANGE", value(health.rangeKm,0), "km", Blue, Modifier.weight(1f))
                    MetricCard("TANK", value(health.tankLitres,1), "L", Amber, Modifier.weight(1f))
                }
                Text("Oil level ${health.oilLevel ?: "--"}  ·  Check Control ${assistant.checkControlActive} active", color=Color.White, fontWeight=FontWeight.SemiBold)
            }
        }
    }
    Card(colors=CardDefaults.cardColors(containerColor=Panel), shape=RoundedCornerShape(18.dp)) {
        Column(Modifier.fillMaxWidth().padding(18.dp), verticalArrangement=Arrangement.spacedBy(8.dp)) {
            Text("TRIPS", color=Cyan, fontWeight=FontWeight.Bold)
            assistant.currentTrip?.let {
                Text("CURRENT", color=Green, fontSize=12.sp, fontWeight=FontWeight.Bold)
                TripRow(it)
            } ?: Text("No active trip", color=Color(0xFF8EA5B5))
            if(assistant.recentTrips.isNotEmpty()) Text("RECENT", color=Color(0xFFAFC1CC), fontSize=12.sp, fontWeight=FontWeight.Bold)
            assistant.recentTrips.take(10).forEach { TripRow(it) }
        }
    }
    if(assistant.services.isNotEmpty()) Card(colors=CardDefaults.cardColors(containerColor=Panel), shape=RoundedCornerShape(18.dp)) {
        Column(Modifier.fillMaxWidth().padding(18.dp), verticalArrangement=Arrangement.spacedBy(8.dp)) {
            Text("SERVICE", color=Cyan, fontWeight=FontWeight.Bold)
            assistant.services.take(10).forEach { item ->
                Row(Modifier.fillMaxWidth()) {
                    Text(item.name, color=Color.White, modifier=Modifier.weight(1f))
                    Text(listOfNotNull(item.distance,item.date).joinToString("  "), color=Color(0xFFAFC1CC))
                }
            }
        }
    }
    Text("Bridge ${assistant.bridgeVersion ?: "--"}  ·  providers ${assistant.providersReady ?: 0}/${assistant.providersTotal ?: 0}", color=Color(0xFF8EA5B5), fontSize=12.sp)
}

@Composable private fun TripRow(trip:TripState) {
    val duration=trip.durationSeconds?.let{"${it/60} min"} ?: "--"
    Row(Modifier.fillMaxWidth().padding(vertical=4.dp), verticalAlignment=Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Text(trip.startedAt?.let{clock(it)} ?: "Trip", color=Color.White, fontWeight=FontWeight.SemiBold)
            Text(duration, color=Color(0xFF8EA5B5), fontSize=12.sp)
        }
        Text("${value(trip.distanceKm,1)} km", color=Cyan, modifier=Modifier.width(82.dp))
        Text("${value(trip.topSpeedKmh,0)} km/h", color=Blue)
    }
}

@Composable private fun ConnectionCard(endpoint:String, token:String, commandToken:String, carId:String, onEndpoint:(String)->Unit, onToken:(String)->Unit, onCommandToken:(String)->Unit, onCar:(String)->Unit, onSave:()->Unit) {
    Card(colors=CardDefaults.cardColors(containerColor=Panel), shape=RoundedCornerShape(18.dp)) {
        Column(Modifier.padding(16.dp), verticalArrangement=Arrangement.spacedBy(10.dp)) {
            Text("CONNECTION", fontWeight=FontWeight.Bold, color=Cyan)
            OutlinedTextField(endpoint,onEndpoint,label={Text("Relay HTTPS URL")},singleLine=true,modifier=Modifier.fillMaxWidth())
            OutlinedTextField(carId,onCar,label={Text("Car ID")},singleLine=true,modifier=Modifier.fillMaxWidth())
            OutlinedTextField(token,onToken,label={Text("Read token")},visualTransformation=PasswordVisualTransformation(),singleLine=true,modifier=Modifier.fillMaxWidth())
            OutlinedTextField(commandToken,onCommandToken,label={Text("Climate command token")},visualTransformation=PasswordVisualTransformation(),singleLine=true,modifier=Modifier.fillMaxWidth())
            Button(onClick=onSave,enabled=endpoint.startsWith("https://")&&token.length>=16&&carId.isNotBlank(),modifier=Modifier.fillMaxWidth()){Text("SAVE AND CONNECT")}
        }
    }
}

private fun isLive(s: Snapshot?): Boolean = s != null && s.awake && Duration.between(s.received, Instant.now()).seconds in 0..89

@Composable private fun ClimateControls(enabled:Boolean, state:String, climate:ClimateState?, send:(JSONObject)->Unit) {
    var temperature by remember { mutableDoubleStateOf(climate?.driverTarget ?: 21.0) }
    var fan by remember { mutableIntStateOf(climate?.fanDriver ?: 3) }
    LaunchedEffect(climate?.driverTarget) { climate?.driverTarget?.let { temperature = it } }
    LaunchedEffect(climate?.fanDriver) { climate?.fanDriver?.let { fan = it.coerceIn(1, 9) } }
    Card(colors=CardDefaults.cardColors(containerColor=Panel),shape=RoundedCornerShape(18.dp)) {
        Column(Modifier.fillMaxWidth().padding(16.dp), verticalArrangement=Arrangement.spacedBy(12.dp)) {
            Row(Modifier.fillMaxWidth(), verticalAlignment=Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text("REMOTE CLIMATE", color=Cyan, fontWeight=FontWeight.Bold)
                    Text(climateMode(climate), color=if(climate?.preconditioning == true) Amber else Color(0xFFAFC1CC), fontSize=12.sp, fontWeight=FontWeight.SemiBold)
                    Text(state, color=Color(0xFFAFC1CC), fontSize=12.sp)
                }
                Text(if(enabled) "CAR ONLINE" else "OFFLINE", color=if(enabled) Green else Amber, fontSize=11.sp, fontWeight=FontWeight.Bold)
            }
            Row(Modifier.fillMaxWidth(), horizontalArrangement=Arrangement.spacedBy(8.dp)) {
                StateButton("CLIMATE ON", climate?.on == true, enabled, Modifier.weight(1f)) { send(JSONObject().put("type","climate_on")) }
                StateButton("OFF", climate?.on == false, enabled, Modifier.weight(1f)) { send(JSONObject().put("type","climate_off")) }
            }
            Row(Modifier.fillMaxWidth(), horizontalArrangement=Arrangement.spacedBy(8.dp)) {
                StateButton("FRONT DEFROST", climate?.frontDefrost == true, enabled, Modifier.weight(1f)) {
                    send(JSONObject().put("type", if (climate?.frontDefrost == true) "defrost_off" else "defrost_on"))
                }
                StateButton("REAR DEFROST", climate?.rearDefrost == true, enabled, Modifier.weight(1f)) {
                    send(JSONObject().put("type", if (climate?.rearDefrost == true) "rear_defrost_off" else "rear_defrost_on"))
                }
            }
            Row(Modifier.fillMaxWidth(), horizontalArrangement=Arrangement.spacedBy(8.dp)) {
                StateButton("SYNC", climate?.sync == true, enabled, Modifier.weight(1f)) {
                    send(JSONObject().put("type","set_sync").put("enabled", climate?.sync != true))
                }
            }
            Text("AIR INTAKE · SHARED FRONT CABIN", color=Color(0xFFAFC1CC), fontSize=12.sp, fontWeight=FontWeight.Bold)
            Row(Modifier.fillMaxWidth(), horizontalArrangement=Arrangement.spacedBy(6.dp)) {
                StateButton("FRESH", climate?.recirculation == "fresh", enabled, Modifier.weight(1f)) {
                    send(JSONObject().put("type","set_recirculation").put("mode","fresh"))
                }
                StateButton("AUC", climate?.recirculation == "auto", enabled, Modifier.weight(1f)) {
                    send(JSONObject().put("type","set_recirculation").put("mode","auto"))
                }
                StateButton("RECIRC", climate?.recirculation == "recirculate", enabled, Modifier.weight(1f)) {
                    send(JSONObject().put("type","set_recirculation").put("mode","recirculate"))
                }
            }
            Text("ZONE AUTO", color=Color(0xFFAFC1CC), fontSize=12.sp, fontWeight=FontWeight.Bold)
            Row(Modifier.fillMaxWidth(), horizontalArrangement=Arrangement.spacedBy(6.dp)) {
                ZoneAutoButton("DRIVER", "driver", climate?.autoDriver, enabled, send, Modifier.weight(1f))
                ZoneAutoButton("FRONT PASS", "frontPassenger", climate?.autoPassenger, enabled, send, Modifier.weight(1f))
            }
            Row(Modifier.fillMaxWidth(), horizontalArrangement=Arrangement.spacedBy(6.dp)) {
                ZoneAutoButton("REAR LEFT", "rearLeft", climate?.autoRearLeft, enabled, send, Modifier.weight(1f))
                ZoneAutoButton("REAR RIGHT", "rearRight", climate?.autoRearRight, enabled, send, Modifier.weight(1f))
            }
            ControlStepper("TARGET", String.format("%.1f °C", temperature), enabled,
                decrease={temperature=(temperature-0.5).coerceAtLeast(16.0)}, increase={temperature=(temperature+0.5).coerceAtMost(28.0)},
                apply={send(JSONObject().put("type","set_temperature").put("celsius",temperature))})
            ControlStepper("FAN", "Level $fan", enabled,
                decrease={fan=(fan-1).coerceAtLeast(1)}, increase={fan=(fan+1).coerceAtMost(9)},
                apply={send(JSONObject().put("type","set_fan").put("level",fan))})
            Text("SEATS", color=Color(0xFFAFC1CC), fontSize=12.sp, fontWeight=FontWeight.Bold)
            SeatControl("Driver", "driver", climate?.driverHeat, climate?.driverVent, enabled, send)
            SeatControl("Front passenger", "frontPassenger", climate?.passengerHeat, climate?.passengerVent, enabled, send)
            SeatControl("Rear left", "rearLeft", climate?.rearLeftHeat, climate?.rearLeftVent, enabled, send)
            SeatControl("Rear right", "rearRight", climate?.rearRightHeat, climate?.rearRightVent, enabled, send)
            Text("Selected controls are confirmed states reported by BMW IHKA. Physical changes in the car sync back automatically.", color=Color(0xFF7E96A5), fontSize=11.sp)
        }
    }
}

@Composable private fun ZoneAutoButton(text:String, zone:String, selected:Boolean?, enabled:Boolean, send:(JSONObject)->Unit, modifier:Modifier=Modifier) {
    StateButton("$text AUTO", selected == true, enabled, modifier) {
        send(JSONObject().put("type","set_auto").put("zone",zone).put("enabled",selected != true))
    }
}

@Composable private fun StateButton(text:String, selected:Boolean, enabled:Boolean, modifier:Modifier=Modifier, click:()->Unit) {
    if (selected) Button(click, enabled=enabled, modifier=modifier) { Text(text) }
    else OutlinedButton(click, enabled=enabled, modifier=modifier) { Text(text) }
}

@Composable private fun ControlStepper(label:String, value:String, enabled:Boolean, decrease:()->Unit, increase:()->Unit, apply:()->Unit) {
    Row(Modifier.fillMaxWidth(), verticalAlignment=Alignment.CenterVertically) {
        Column(Modifier.weight(1f)){Text(label,color=Color(0xFF7E96A5),fontSize=11.sp);Text(value,color=Color.White,fontWeight=FontWeight.Bold)}
        OutlinedButton(decrease, enabled=enabled, contentPadding=PaddingValues(horizontal=14.dp)){Text("−")}
        Spacer(Modifier.width(6.dp)); OutlinedButton(increase, enabled=enabled, contentPadding=PaddingValues(horizontal=14.dp)){Text("+")}
        Spacer(Modifier.width(6.dp)); Button(apply, enabled=enabled){Text("SET")}
    }
}

@Composable private fun SeatControl(label:String, seat:String, heat:Int?, vent:Int?, enabled:Boolean, send:(JSONObject)->Unit) {
    Column(Modifier.fillMaxWidth(), verticalArrangement=Arrangement.spacedBy(5.dp)) {
        Text(label, color=Color.White, fontWeight=FontWeight.SemiBold, fontSize=13.sp)
        Row(Modifier.fillMaxWidth(), horizontalArrangement=Arrangement.spacedBy(5.dp)) {
            Text("HEAT", color=Red, fontSize=10.sp, modifier=Modifier.width(36.dp).align(Alignment.CenterVertically))
            (0..3).forEach { level -> SmallLevelButton(if(level==0) "OFF" else "$level", heat==level, enabled) { send(JSONObject().put("type","seat_heat").put("seat",seat).put("level",level)) } }
        }
        Row(Modifier.fillMaxWidth(), horizontalArrangement=Arrangement.spacedBy(5.dp)) {
            Text("VENT", color=Blue, fontSize=10.sp, modifier=Modifier.width(36.dp).align(Alignment.CenterVertically))
            (0..3).forEach { level -> SmallLevelButton(if(level==0) "OFF" else "$level", vent==level, enabled) { send(JSONObject().put("type","seat_vent").put("seat",seat).put("level",level)) } }
        }
    }
}

@Composable private fun SmallLevelButton(text:String, selected:Boolean, enabled:Boolean, click:()->Unit) {
    val modifier=Modifier.height(34.dp)
    val padding=PaddingValues(horizontal=12.dp, vertical=0.dp)
    if(selected) Button(click, enabled=enabled, modifier=modifier, contentPadding=padding){Text(text, fontSize=11.sp)}
    else OutlinedButton(click, enabled=enabled, modifier=modifier, contentPadding=padding){Text(text, fontSize=11.sp)}
}

@Composable private fun FreshnessCard(s:Snapshot?, error:String?, loading:Boolean, refresh:()->Unit) {
    val age=s?.let{Duration.between(it.received,Instant.now()).seconds.coerceAtLeast(0)}
    val live=age!=null&&age<90&&s.awake
    val color=if(live) Green else if(s!=null) Amber else Red
    Card(colors=CardDefaults.cardColors(containerColor=Panel),shape=RoundedCornerShape(18.dp)) {
        Row(Modifier.fillMaxWidth().padding(16.dp),verticalAlignment=Alignment.CenterVertically) {
            Box(Modifier.size(10.dp).background(color, RoundedCornerShape(5.dp)))
            Column(Modifier.padding(start=12.dp).weight(1f)) {
                Text(if(live) "CAR ONLINE" else if(s!=null) "LAST PARKED SNAPSHOT" else "NO DATA",color=color,fontWeight=FontWeight.Bold)
                Text(error ?: s?.let{"Updated ${ageText(age!!)} ago · ${clock(it.received)}"} ?: "Configure the relay connection",color=Color(0xFFAFC1CC),fontSize=13.sp)
            }
            TextButton(onClick=refresh,enabled=!loading){Text(if(loading)"…" else "REFRESH")}
        }
    }
}

@Composable private fun HeroTemperature(snapshot:Snapshot?) {
    val inside=snapshot?.inside
    val sampleAge=snapshot?.insideSampled?.let { Duration.between(it, Instant.now()).seconds.coerceAtLeast(0) }
    val current=isLive(snapshot) && sampleAge != null && sampleAge < 90
    val color=when { !current || inside==null->Color(0xFF718895); inside>=45->Red; inside>=35->Amber; else->Cyan }
    Card(colors=CardDefaults.cardColors(containerColor=Color(0xFF102B3A)),shape=RoundedCornerShape(24.dp)) {
        Column(Modifier.fillMaxWidth().padding(22.dp)) {
            Text("CABIN TEMPERATURE",color=Color(0xFFAFC1CC),fontSize=13.sp,fontWeight=FontWeight.Bold)
            Row(verticalAlignment=Alignment.Bottom) {
                Text(if(current) temp(inside) else "--",color=color,fontSize=76.sp,fontWeight=FontWeight.Black)
                Text(" °C",color=color,fontSize=28.sp,modifier=Modifier.padding(bottom=12.dp))
            }
            Text(when {
                current && inside != null -> "${snapshot?.insideSource ?: "IHKA cabin sensor"} · measured ${ageText(sampleAge!!)} ago"
                inside != null && snapshot?.insideSampled != null -> "Last measured ${temp(inside)} °C at ${clock(snapshot.insideSampled)} · car data is stale"
                else -> "Waiting for a confirmed IHKA cabin-temperature sample"
            },color=color)
        }
    }
}

@Composable private fun MetricCard(title:String, number:String, unit:String, color:Color, modifier:Modifier=Modifier) {
    Card(modifier,colors=CardDefaults.cardColors(containerColor=Panel),shape=RoundedCornerShape(18.dp)) {
        Column(Modifier.padding(16.dp)) {Text(title,color=Color(0xFFAFC1CC),fontSize=12.sp,fontWeight=FontWeight.Bold);Row(verticalAlignment=Alignment.Bottom){Text(number,color=color,fontSize=32.sp,fontWeight=FontWeight.Bold);Text(" $unit",color=color,fontSize=15.sp,modifier=Modifier.padding(bottom=4.dp))}}
    }
}

@Composable private fun TyreCard(t:Tyres?) {
    Card(colors=CardDefaults.cardColors(containerColor=Panel),shape=RoundedCornerShape(18.dp)) {
        Column(Modifier.fillMaxWidth().padding(16.dp),verticalArrangement=Arrangement.spacedBy(10.dp)) {
            Text("TYRE PRESSURES",color=Color(0xFFAFC1CC),fontSize=12.sp,fontWeight=FontWeight.Bold)
            Row(Modifier.fillMaxWidth(),horizontalArrangement=Arrangement.SpaceBetween){Tyre("FL",t?.fl);Tyre("FR",t?.fr);Tyre("RL",t?.rl);Tyre("RR",t?.rr)}
        }
    }
}
@Composable private fun Tyre(label:String, v:Double?){Column(horizontalAlignment=Alignment.CenterHorizontally){Text(label,color=Color(0xFF7E96A5),fontSize=12.sp);Text(if(v==null)"--" else String.format("%.1f",v),color=Color.White,fontSize=22.sp,fontWeight=FontWeight.Bold);Text("bar",color=Color(0xFF7E96A5),fontSize=11.sp)}}

private suspend fun fetchSnapshot(endpoint:String, token:String, carId:String):Snapshot = withContext(Dispatchers.IO) {
    val connection=(URL(endpoint.trimEnd('/')+"/v1/cars/"+carId+"/telemetry").openConnection() as HttpURLConnection)
    connection.connectTimeout=12_000;connection.readTimeout=12_000;connection.setRequestProperty("Authorization","Bearer $token");connection.setRequestProperty("Accept","application/json")
    val code=connection.responseCode
    val body=(if(code in 200..299)connection.inputStream else connection.errorStream)?.bufferedReader()?.use{it.readText()} ?: ""
    if(code !in 200..299) throw IllegalStateException("Relay HTTP $code")
    val root=JSONObject(body);val t=root.getJSONObject("telemetry")
    fun number(name:String)=if(t.has(name)&&!t.isNull(name))t.getDouble(name) else null
    val tyre = if (t.has("tyrePressureBar")) {
        val x = t.getJSONObject("tyrePressureBar")
        fun tyreNumber(name: String): Double? =
            if (x.has(name) && !x.isNull(name)) x.getDouble(name) else null
        Tyres(
            tyreNumber("frontLeft"), tyreNumber("frontRight"),
            tyreNumber("rearLeft"), tyreNumber("rearRight")
        )
    } else null
    val climate = root.optJSONObject("climate")?.let { c ->
        fun bool(name:String):Boolean? = if(c.has(name) && !c.isNull(name)) c.getBoolean(name) else null
        fun num(name:String):Double? = if(c.has(name) && !c.isNull(name)) c.getDouble(name) else null
        fun string(name:String):String? = if(c.has(name) && !c.isNull(name)) c.getString(name) else null
        fun level(name:String):Int? = num(name)?.toInt()
        ClimateState(
            bool("on"), bool("frontDefrost"), bool("rearDefrost"),
            bool("preconditioning"), string("preconditioningMode"), string("operatingMode"), bool("engineRunning"),
            num("driverTargetC"), num("passengerTargetC"),
            level("fanDriver"), level("fanPassenger"), level("fanRear"),
            bool("autoDriver"), bool("autoPassenger"), bool("autoRearLeft"), bool("autoRearRight"),
            bool("sync"), string("recirculation"),
            level("driverHeat"), level("passengerHeat"), level("rearLeftHeat"), level("rearRightHeat"),
            level("driverVent"), level("passengerVent"), level("rearLeftVent"), level("rearRightVent")
        )
    }
    fun instant(value:String?):Instant? = value?.takeIf{it.isNotBlank()&&it!="null"}?.let{runCatching{Instant.parse(it)}.getOrNull()}
    fun parseTrip(x:JSONObject):TripState {
        fun num(name:String):Double? = if(x.has(name)&&!x.isNull(name)) x.optDouble(name) else null
        return TripState(x.optString("id","trip"), instant(x.optString("startedAt")), instant(x.optString("endedAt")),
            num("distanceKm"), num("durationSeconds")?.toInt(), num("topSpeedKmh"), num("fuelUsedLitres"))
    }
    val assistant = root.optJSONObject("assistant")?.let { a ->
        val w=a.optJSONObject("warmup")?.let { w ->
            WarmupState(w.optBoolean("active",false), if(w.has("progressPercent"))w.optInt("progressPercent") else null,
                if(w.has("estimatedMinutesRemaining")&&!w.isNull("estimatedMinutesRemaining"))w.optDouble("estimatedMinutesRemaining") else null,
                if(w.has("estimatedKmRemaining")&&!w.isNull("estimatedKmRemaining"))w.optDouble("estimatedKmRemaining") else null,
                if(w.has("safeRpm"))w.optInt("safeRpm") else null, instant(w.optString("completedAt")))
        }
        val trip=a.optJSONObject("trip")
        val current=trip?.optJSONObject("current")?.let(::parseTrip)
        val recent=buildList {
            val values=trip?.optJSONArray("recent")
            if(values!=null) for(i in 0 until values.length()) values.optJSONObject(i)?.let{add(parseTrip(it))}
        }.reversed()
        val health=a.optJSONObject("health")?.let { h ->
            fun num(name:String):Double? = if(h.has(name)&&!h.isNull(name))h.optDouble(name) else null
            HealthState(num("coolantC"),num("oilTemperatureC"),h.optString("oilLevel").takeIf{it.isNotBlank()},num("rangeKm"),num("tankLitres"))
        }
        val services=buildList {
            val values=a.optJSONObject("service")?.optJSONArray("items")
            if(values!=null) for(i in 0 until values.length()) values.optJSONObject(i)?.let{x ->
                val name=x.optString("name").trim()
                if(name.isNotEmpty()) add(ServiceItem(name,x.optString("distance").takeIf{it.isNotBlank()},x.optString("date").takeIf{it.isNotBlank()}))
            }
        }
        val check=a.optJSONObject("checkControl")?.optInt("active",0) ?: 0
        val link=a.optJSONObject("connection")
        AssistantState(w,current,recent,health,services,check,link?.optString("bridgeVersion")?.takeIf{it.isNotBlank()},
            link?.let{if(it.has("providersReady"))it.optInt("providersReady") else null},link?.let{if(it.has("providersTotal"))it.optInt("providersTotal") else null})
    }
    Snapshot(
        Instant.parse(root.getString("serverReceivedAt")),
        root.optString("sampledAt").takeIf{it.isNotBlank()&&it!="null"}?.let{Instant.parse(it)},
        root.optBoolean("awake",false), number("insideTemperatureC"),
        t.optString("insideTemperatureSampledAt").takeIf{it.isNotBlank()&&it!="null"}?.let{Instant.parse(it)},
        t.optString("insideTemperatureSource").takeIf{it.isNotBlank()&&it!="null"},
        number("outsideTemperatureC"),
        number("batteryChargePercent"), number("batteryVoltage"), number("speedKmh"), tyre, climate, assistant
    )
}

private suspend fun sendCommand(endpoint:String, token:String, carId:String, command:JSONObject):CommandResult = withContext(Dispatchers.IO) {
    if (token.isBlank()) throw IllegalStateException("Add the climate command token in Setup")
    val base = endpoint.trimEnd('/') + "/v1/cars/" + URLEncoder.encode(carId, "UTF-8") + "/commands"
    fun request(target:String, method:String, body:String? = null):Pair<Int,String> {
        val connection = URL(target).openConnection() as HttpURLConnection
        connection.requestMethod=method;connection.connectTimeout=12_000;connection.readTimeout=12_000
        connection.setRequestProperty("Authorization","Bearer $token");connection.setRequestProperty("Accept","application/json")
        if(body!=null){connection.doOutput=true;connection.setRequestProperty("Content-Type","application/json");connection.outputStream.use{it.write(body.toByteArray())}}
        val code=connection.responseCode
        val text=(if(code in 200..299)connection.inputStream else connection.errorStream)?.bufferedReader()?.use{it.readText()} ?: ""
        return code to text
    }
    val (queuedCode, queuedText)=request(base,"POST",command.toString())
    if(queuedCode !in 200..299) throw IllegalStateException("Command relay HTTP $queuedCode")
    val queued=JSONObject(queuedText);val id=queued.getString("id")
    repeat(24) {
        Thread.sleep(2500)
        val (code,text)=request("$base/$id","GET")
        if(code==200){val value=JSONObject(text);val status=value.optString("status","queued");if(status in setOf("accepted","rejected","error","expired")) return@withContext CommandResult(id,status,value.optString("result").takeIf{it.isNotBlank()})}
    }
    CommandResult(id,"queued",null)
}
private fun value(v:Double?,digits:Int)=v?.let{String.format("%.${digits}f",it)}?:"--"
private fun temp(v:Double?)=value(v,1)
private fun climateMode(c:ClimateState?):String = when {
    c?.preconditioning == true -> "PRECONDITIONING · ${c.preconditioningMode?.uppercase() ?: "ACTIVE"}"
    c?.engineRunning == true -> "ENGINE RUNNING · CABIN CLIMATE"
    c?.operatingMode == "parked" -> "PARKED · AUXILIARY CLIMATE READY"
    else -> "BMW IHKA STATE"
}
private fun batteryColor(v:Double?)=when{v==null->Color(0xFF718895);v<35->Red;v<55->Amber;else->Green}
private fun voltageColor(v:Double?)=when{v==null->Color(0xFF718895);v<11.8->Red;v<12.2->Amber;else->Green}
private fun ageText(s:Long)=when{ s<60->"${s}s";s<3600->"${s/60}m";s<86400->"${s/3600}h";else->"${s/86400}d" }
private fun clock(i:Instant)=DateTimeFormatter.ofPattern("HH:mm").withZone(ZoneId.systemDefault()).format(i)
