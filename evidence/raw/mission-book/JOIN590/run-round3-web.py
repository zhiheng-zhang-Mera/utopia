import subprocess,xml.etree.ElementTree as E,json
a=['D:/Tools/UtopiaAndroidSdk/platform-tools/adb.exe','-s','BICIPVNB5HS85H9T']
raw=subprocess.check_output(a+['exec-out','run-as','city.utopia.control.join590review','cat','shared_prefs/city-connection.xml'])
p={x.get('name'):x.text for x in E.fromstring(raw)}
subprocess.run(['node','.runtime/round3-web.mjs'],input=json.dumps({'host':p['host'],'token':p['token']}).encode(),check=True)
