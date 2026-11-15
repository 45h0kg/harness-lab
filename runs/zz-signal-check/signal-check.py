import subprocess,os,sys,time
def test(profile_text,label):
    open("p.sb","w").write(profile_text)
    victim=subprocess.Popen(["sleep","300"],start_new_session=True)
    cmd=f"kill {victim.pid} 2>&1; echo other-kill-exit $?; sleep 30 & K=$!; kill $K 2>&1; echo own-child-kill-exit $?; node -e 'console.log(\"node ok\")'; git --version"
    r=subprocess.run(["/usr/bin/sandbox-exec","-f","p.sb","/bin/sh","-c",cmd],start_new_session=True,capture_output=True,text=True,timeout=60)
    time.sleep(0.3)
    alive=victim.poll() is None
    print("===",label); print(r.stdout+r.stderr, "victim alive" if alive else "victim DEAD")
    if alive: victim.kill()
test("(version 1)\n(allow default)\n(deny signal (target others))\n","lab guard: deny signal (target others)")
test("(version 1)\n(allow default)\n",               "no rule")
