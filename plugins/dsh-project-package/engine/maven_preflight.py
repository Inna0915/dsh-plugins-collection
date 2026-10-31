"""Identify other Maven CLI builds without stopping unrelated Java services."""
import os
import psutil

MAVEN_MAIN_CLASSES = ('org.codehaus.plexus.classworlds.launcher.Launcher',
                      'org.apache.maven.wrapper.MavenWrapperMain', 'org.apache.maven.cli.MavenCli',
                      'org.apache.maven.cling.MavenCling')


def running_maven(owner_pid=None):
    owner_pid = owner_pid or os.getpid()
    found = []
    for process in psutil.process_iter(['pid', 'name']):
        if (process.info.get('name') or '').lower() not in ('java.exe', 'javaw.exe', 'java', 'javaw'):
            continue
        try:
            arguments = process.cmdline()
            if not any(main in arguments for main in MAVEN_MAIN_CLASSES):
                continue
            if process.pid == owner_pid or any(parent.pid == owner_pid for parent in process.parents()):
                continue  # This engine's cancelled background resolver is managed separately.
            project = next((arg.split('=', 1)[1] for arg in arguments if arg.startswith('-Dmaven.multiModuleProjectDirectory=')), '')
            if not project:
                project = process.cwd()
            found.append({'pid': process.pid, 'project': project})
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            continue
    return found
