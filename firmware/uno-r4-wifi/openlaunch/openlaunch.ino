/* openlaunch development firmware: HTTPS polling, built-in LED, matrix, health.
 * Provision once over USB Serial at 115200 using a JSON object containing:
 * ssid,password,host,workspace,enrollmentToken. Never paste real credentials into Git.
 * Credentials are stored in plain EEPROM; this is not tamper-resistant storage.
 * Host must match its TLS certificate. No insecure TLS mode is provided.
 */
#include <WiFiS3.h>
#include <ArduinoHttpClient.h>
#include <ArduinoJson.h>
#include <ArduinoGraphics.h>
#include <Arduino_LED_Matrix.h>
#include <EEPROM.h>
struct Config { uint32_t magic; char ssid[33],password[65],host[128],workspace[65],deviceId[37],token[65]; } cfg;
const uint32_t MAGIC=0x4F4C0001;
ArduinoLEDMatrix matrix;
char lastAction[37]={0};
unsigned long lastPoll=0;
void saveConfig(){cfg.magic=MAGIC;EEPROM.put(0,cfg);}
bool safeCopy(char* dst,size_t n,JsonVariantConst src){const char* s=src.as<const char*>();if(!s||strlen(s)>=n)return false;strcpy(dst,s);return true;}
bool post(const String& path,JsonDocument& data,JsonDocument& response){
 WiFiSSLClient tls;HttpClient client(tls,cfg.host,443);client.setHttpResponseTimeout(12000);String body;serializeJson(data,body);
 client.beginRequest();client.post(path);client.sendHeader("Content-Type","application/json");client.sendHeader("Content-Length",body.length());client.sendHeader("x-openlaunch-workspace",cfg.workspace);if(cfg.token[0])client.sendHeader("Authorization",String("Bearer ")+cfg.token);client.beginBody();client.print(body);client.endRequest();
 int status=client.responseStatusCode();if(status<200||status>=300){client.stop();return false;}int length=client.contentLength();if(length>8192){client.stop();return false;}
 String payload=client.responseBody();client.stop();if(payload.length()>8192)return false;return !deserializeJson(response,payload);
}
void setup(){Serial.begin(115200);pinMode(LED_BUILTIN,OUTPUT);digitalWrite(LED_BUILTIN,LOW);matrix.begin();EEPROM.get(0,cfg);if(cfg.magic!=MAGIC){memset(&cfg,0,sizeof(cfg));Serial.println("openlaunch: requires USB provisioning; no device credentials are printed");}}
void provision(){
 if(!Serial.available())return;String line=Serial.readStringUntil('\n');if(line.length()>1024)return;JsonDocument input;if(deserializeJson(input,line))return;
 if(input["reset"].as<bool>()){memset(&cfg,0,sizeof(cfg));EEPROM.put(0,cfg);WiFi.disconnect();Serial.println("openlaunch: reset");return;}
 if(cfg.magic==MAGIC&&cfg.token[0]){Serial.println("openlaunch: already paired; explicit reset required");return;}
 if(!safeCopy(cfg.ssid,sizeof(cfg.ssid),input["ssid"])||!safeCopy(cfg.password,sizeof(cfg.password),input["password"])||!safeCopy(cfg.host,sizeof(cfg.host),input["host"])||!safeCopy(cfg.workspace,sizeof(cfg.workspace),input["workspace"]))return;
 for(size_t i=0;i<strlen(cfg.host);i++)if(!(isalnum(cfg.host[i])||cfg.host[i]=='.'||cfg.host[i]=='-'))return;
 const char* enrollment=input["enrollmentToken"]|"";if(strlen(enrollment)!=64||strlen(cfg.workspace)!=64)return;
 cfg.token[0]=0;WiFi.begin(cfg.ssid,cfg.password);unsigned long until=millis()+20000;while(WiFi.status()!=WL_CONNECTED&&(long)(until-millis())>0)delay(100);if(WiFi.status()!=WL_CONNECTED)return;
 JsonDocument request,response;request["token"]=enrollment;request["manifest"]["name"]="uno-r4-wifi";request["manifest"]["kind"]="uno-r4-wifi";auto caps=request["manifest"]["capabilities"].to<JsonArray>();caps.add("device.health");caps.add("led.set");caps.add("display.text");
 if(post("/v1/device/enroll",request,response)&&safeCopy(cfg.deviceId,sizeof(cfg.deviceId),response["data"]["deviceId"])&&safeCopy(cfg.token,sizeof(cfg.token),response["data"]["token"])){saveConfig();Serial.println("openlaunch: paired");}
}
void loop(){
 provision();if(cfg.magic!=MAGIC||!cfg.token[0]){delay(100);return;}
 if(WiFi.status()!=WL_CONNECTED){WiFi.begin(cfg.ssid,cfg.password);delay(10000);return;}
 if(millis()-lastPoll<10000){delay(20);return;}lastPoll=millis();JsonDocument request,response;if(!post(String("/v1/device/")+cfg.deviceId+"/next",request,response)||response["data"].isNull())return;
 JsonObject cmd=response["data"];const char* id=cmd["id"]|"";if(strlen(id)!=36||strcmp(id,lastAction)==0)return;strcpy(lastAction,id);
 JsonDocument ack,reply;ack["actionId"]=id;ack["status"]="failed";unsigned long epoch=WiFi.getTime();uint64_t expires=cmd["expiresAt"].as<uint64_t>();
 if(epoch<1700000000||((uint64_t)epoch*1000)>=expires){ack["result"]["error"]="clock_unavailable_or_expired";}
 else {const char* cap=cmd["capability"]|"";
 if(strcmp(cap,"device.health")==0){ack["status"]="succeeded";ack["result"]["uptimeMs"]=millis();ack["result"]["rssi"]=WiFi.RSSI();ack["result"]["board"]="uno-r4-wifi";}
 else if(strcmp(cap,"led.set")==0&&cmd["args"]["on"].is<bool>()){bool on=cmd["args"]["on"];digitalWrite(LED_BUILTIN,on?HIGH:LOW);ack["status"]="succeeded";ack["result"]["on"]=on;}
 else if(strcmp(cap,"display.text")==0){const char* text=cmd["args"]["text"]|"";bool valid=strlen(text)<=96;for(size_t i=0;i<strlen(text);i++)if(text[i]<32||text[i]>126)valid=false;if(valid){matrix.beginDraw();matrix.stroke(0xFFFFFFFF);matrix.textFont(Font_5x7);matrix.textScrollSpeed(50);matrix.beginText(0,1,0xFFFFFF);matrix.print(text);matrix.endText(SCROLL_LEFT);matrix.endDraw();ack["status"]="succeeded";ack["result"]["text"]=text;}else ack["result"]["error"]="ascii_text_required";}
 else ack["result"]["error"]="unsupported_capability";}
 post(String("/v1/device/")+cfg.deviceId+"/result",ack,reply);
}
